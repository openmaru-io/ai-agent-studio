/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 작업공간 크기와 남은 자리 화면 조각(스펙 2026-10-30-003 §4-5·§4-7, 디자인 리뷰 1A~7A). 「AI 에이전트」 화면이 관리자에게 쓴다:
// 숫자 카드 「더 만들 수 있는 작업공간」(1B), 노드 표 서랍(1B·6A), 크기 입력(4A·4B), 저장 전 확인·막힘·그래도 저장(3A·5A), 적용 확인 창.
// 계산은 서버가 한다(/api/agents/capacity·/api/agents/sizes). 화면은 단위만 바꾼다(lib/sizeUnits).
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogContentText,
  DialogTitle,
  InputAdornment,
  LinearProgress,
  Slider,
  Stack,
  Table,
  TableBody,
  TableCell,
  TableHead,
  TableRow,
  TextField,
  type Theme,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { type ReactNode, useId, useRef, useState } from 'react';

import { Pill } from '@/components/DataGrid';
import type { ListCard } from '@/components/ListView';
import { tier1, tier2, tier3 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { FOCUS_RING } from '@/lib/shellTokens';
import { displayQty, draftToQty, fmtUnit, GIB, kindOf, parseQty, sameQty, SIZE_FIELDS, type SizeField, type SizeValues, toUnit } from '@/lib/sizeUnits';

export interface CapacityNode {
  name: string;
  slots: number;
  free_cpu: number;
  free_memory: number;
  cpu_request_pct: number | null;
  memory_request_pct: number | null;
  memory_limit_pct: number | null;
  limited_by: string;
  /** 노드 전체(allocatable). 옛 서버는 주지 않는다 */
  total_cpu?: number;
  total_memory?: number;
}

/** GET /api/agents/capacity(관리자 모양, §4-8). 일반 사용자는 available 만 받는다 */
export interface CapacityData {
  state: 'ok' | 'unknown' | 'stale' | 'error';
  slots: number | null;
  by_node: CapacityNode[];
  top_node: { name: string; slots: number } | null;
  pending: { count: number; slots: number } | null;
  quota_limited: boolean;
  computed_at: string;
  checked_at: string;
  pod: { cpu: number; memory: number } | null;
  short: Record<string, number>;
  suspended?: number;
  available?: boolean | null;
}

/** GET /api/agents/sizes(§4-8) */
export interface SizesData {
  install: SizeValues | null;
  admin: SizeValues;
  people: Record<string, SizeValues>;
  agents: Record<string, { size: SizeValues; pvc: string | null }>;
}

export interface BlockedInfo {
  reason: string;
  agents: string[];
  nodes: { name: string; free_cpu: number; free_memory: number }[];
}

export const BLANK: SizeValues = { cpu_request: null, memory_request: null, cpu_limit: null, memory_limit: null, storage: null };
const tabular = { fontVariantNumeric: 'tabular-nums' } as const;
const focusSx = { '&.Mui-focusVisible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 } } as const;

export const capacityUrl = (cpu?: string | null, memory?: string | null) => {
  const q = new URLSearchParams();
  if (cpu) q.set('cpu_request', cpu);
  if (memory) q.set('memory_request', memory);
  const s = q.toString();
  return `/api/agents/capacity${s ? `?${s}` : ''}`;
};

/** 남은 자리. 오퍼레이터가 30초마다 세므로 1분마다 다시 읽는다 */
export function useCapacity(enabled: boolean) {
  return useQuery<CapacityData>({ queryKey: ['agent-capacity'], queryFn: () => get<CapacityData>(capacityUrl()), enabled, staleTime: 15000, refetchInterval: enabled ? 60000 : false, retry: false });
}

export function useSizes(enabled: boolean) {
  // 빠진 칸은 빈 값으로 채운다 — 서버가 옛 판이면 칸이 없다
  const norm = (r: Partial<SizesData>): SizesData => ({
    install: r.install ?? null,
    admin: { ...BLANK, ...(typeof r.admin === 'object' ? r.admin : {}) },
    people: typeof r.people === 'object' && r.people ? r.people : {},
    agents: typeof r.agents === 'object' && r.agents && !Array.isArray(r.agents) ? r.agents : {},
  });
  return useQuery<SizesData>({ queryKey: ['agent-sizes'], queryFn: () => get<Partial<SizesData>>('/api/agents/sizes').then(norm), enabled, retry: false });
}

/** 사용자 만들기 서랍의 「자리 없음」(D10). 모르면 null */
export function capacityAvailable(d?: CapacityData): boolean | null {
  if (!d) return null;
  if (d.available !== undefined) return d.available;
  return (d.state === 'ok' || d.state === 'stale') && d.slots != null ? d.slots > 0 : null;
}

/** 「3분 전」·「30초 전」 */
export function ago(ts: string, now: number): string {
  const s = Math.max(0, Math.round((now - Date.parse(ts)) / 1000));
  return s < 60 ? t('sizes.ago.sec', { n: s }) : t('sizes.ago.min', { n: Math.floor(s / 60) });
}

/** 자리 0개일 때 가장 많은 노드가 막힌 이유 */
function shortText(d: CapacityData): string {
  if (!d.by_node.length) return t('sizes.node.none');
  const [why, n] = Object.entries(d.short).sort((a, b) => b[1] - a[1])[0] ?? ['memory', d.by_node.length];
  return t(`sizes.card.short.${why === 'cpu' || why === 'pods' ? why : 'memory'}`, { n });
}

/** 숫자 카드(§4-7 상태 표 첫 줄). 누르면 노드 표 서랍(1B·R8) */
export function capacityCard(d: CapacityData | undefined, failed: boolean, now: number, onClick: () => void): ListCard {
  const label = t('sizes.card.label');
  const open = t('sizes.card.open');
  const dash = (sub?: string): ListCard => ({ n: '—', label, sub, onClick, ariaLabel: [label, sub ?? t('common.loading'), open].join(', ') });
  if (failed || d?.state === 'error') return dash(t('sizes.card.error'));
  if (!d) return dash();
  if (d.state === 'unknown' || d.slots == null) return dash(t('sizes.card.unknown'));
  const parts: string[] = [];
  let tone: ListCard['tone'];
  if (d.state === 'stale') {
    parts.push(t('sizes.card.stale', { ago: ago(d.checked_at, now) }));
    tone = 'warn';
  }
  if (d.slots === 0) {
    parts.push(d.quota_limited ? t('sizes.card.quota') : shortText(d));
    tone = 'warn';
  } else if (d.quota_limited) parts.push(t('sizes.card.quota'));
  else if (d.top_node) parts.push(t('sizes.card.top', { n: d.top_node.slots, node: d.top_node.name }));
  const sub = parts.join(' · ') || undefined;
  return { n: d.slots, label, sub, tone, onClick, ariaLabel: [t('sizes.card.aria', { n: d.slots }), ...(sub ? [sub] : []), open].join(', ') };
}

const pctCell = (v: number | null, warnAbove: number) =>
  v == null ? '—' : v > warnAbove ? (
    <Pill flush tone="warn">
      {`${v}%`}
    </Pill>
  ) : (
    `${v}%`
  );

/** 막대 하나: 전체 폭이 노드 전체(allocatable), 채운 부분이 이미 요청된 양. 90% 를 넘으면 amber(5B). 글자가 같은 값을 말하므로 막대는 읽기 도구에서 숨긴다 */
function UsageBar({ pct }: { pct: number | null }) {
  const warn = pct != null && pct > 90;
  return (
    <Box aria-hidden sx={{ height: 6, borderRadius: 3, bgcolor: 'action.hover', overflow: 'hidden' }}>
      <Box sx={{ height: '100%', width: `${Math.min(100, Math.max(0, pct ?? 0))}%`, borderRadius: 3, bgcolor: warn ? 'warning.main' : 'text.primary', opacity: warn ? 1 : 0.7 }} />
    </Box>
  );
}

interface NodeView {
  name: string;
  slots: number;
  limitedBy?: string;
  freeCpu: number;
  totalCpu: number | null;
  cpuPct: number | null;
  freeMem: number;
  totalMem: number | null;
  memPct: number | null;
  limitPct: number | null;
}

const fromNode = (n: CapacityNode): NodeView => ({
  name: n.name,
  slots: n.slots,
  limitedBy: n.limited_by,
  freeCpu: n.free_cpu,
  totalCpu: n.total_cpu ?? null,
  cpuPct: n.cpu_request_pct,
  freeMem: n.free_memory,
  totalMem: n.total_memory ?? null,
  memPct: n.memory_request_pct,
  limitPct: n.memory_limit_pct,
});

/** 모든 노드의 합. 전체를 모르는 노드(옛 서버)가 있으면 전체 칸은 「—」 */
function sumNodes(nodes: CapacityNode[], slots: number): NodeView {
  const add = (f: (n: CapacityNode) => number | null | undefined) => (nodes.every((n) => f(n) != null) ? nodes.reduce((a, n) => a + (f(n) as number), 0) : null);
  const totalCpu = add((n) => n.total_cpu);
  const totalMem = add((n) => n.total_memory);
  const freeCpu = nodes.reduce((a, n) => a + n.free_cpu, 0);
  const freeMem = nodes.reduce((a, n) => a + n.free_memory, 0);
  const pct = (part: number | null, whole: number | null) => (part != null && whole ? Math.round((100 * part) / whole) : null);
  const memReq = add((n) => (n.total_memory != null && n.memory_request_pct != null ? (n.total_memory * n.memory_request_pct) / 100 : null));
  const memLim = add((n) => (n.total_memory != null && n.memory_limit_pct != null ? (n.total_memory * n.memory_limit_pct) / 100 : null));
  const cpuReq = add((n) => (n.total_cpu != null && n.cpu_request_pct != null ? (n.total_cpu * n.cpu_request_pct) / 100 : null));
  return { name: t('sizes.node.all'), slots, freeCpu, totalCpu, cpuPct: pct(cpuReq, totalCpu), freeMem, totalMem, memPct: pct(memReq, totalMem), limitPct: pct(memLim, totalMem) };
}

/** 노드 한 덩어리: 이름과 자리 수, CPU·메모리 막대와 「남음 / 전체」, 메모리 요청·한도 합 비율 */
function NodeBlock({ v, all }: { v: NodeView; all?: boolean }) {
  const cpuUnit = t('sizes.unit.cpu');
  const line = (label: string, pct: number | null, free: string, total: string | null, unit: string) => (
    <>
      <Typography variant="body2" color="text.secondary">
        {label}
      </Typography>
      <UsageBar pct={pct} />
      <Typography variant="body2" sx={{ ...tabular, textAlign: 'right', whiteSpace: 'nowrap' }}>
        {total == null ? t('sizes.node.freeOnly', { free, unit }) : t('sizes.node.freeOf', { free, total, unit })}
      </Typography>
    </>
  );
  return (
    <Box data-capacity-node={all ? '' : v.name} data-capacity-all={all ? '' : undefined} sx={{ pt: all ? 0 : 2, pb: 2 }}>
      <Stack direction="row" alignItems="flex-start" justifyContent="space-between" spacing={2} sx={{ mb: 1.25 }}>
        <Box sx={{ minWidth: 0 }}>
          <Typography variant="subtitle2" component="h3" sx={{ m: 0, fontWeight: all ? 700 : 600, overflowWrap: 'anywhere' }}>
            {v.name}
          </Typography>
          {!all && v.slots === 0 && v.limitedBy && (
            <Typography variant="caption" sx={{ color: 'warning.main' }}>
              {t(`sizes.node.short.${v.limitedBy === 'cpu' || v.limitedBy === 'pods' ? v.limitedBy : 'memory'}`)}
            </Typography>
          )}
        </Box>
        <Box sx={{ textAlign: 'right', flexShrink: 0 }}>
          <Typography component="span" sx={{ ...tabular, fontSize: all ? 28 : 22, fontWeight: 600, lineHeight: 1, color: v.slots === 0 ? 'warning.main' : 'text.primary' }}>
            {v.slots}
          </Typography>
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 0.5 }}>
            {t('sizes.node.slotsUnit')}
          </Typography>
        </Box>
      </Stack>
      <Box sx={{ display: 'grid', gridTemplateColumns: '48px minmax(60px, 1fr) 13.5em', columnGap: 1.5, rowGap: 0.75, alignItems: 'center' }}>
        {line(t('sizes.res.cpu'), v.cpuPct, fmtUnit(v.freeCpu), v.totalCpu == null ? null : fmtUnit(v.totalCpu), cpuUnit)}
        {line(t('sizes.res.memory'), v.memPct, fmtUnit(v.freeMem / GIB), v.totalMem == null ? null : fmtUnit(v.totalMem / GIB), 'GiB')}
        <span />
        <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ gridColumn: 'span 2', color: 'text.secondary', typography: 'caption', ...tabular }}>
          <span>
            {t('sizes.node.memReq')} {pctCell(v.memPct, 90)}
          </span>
          <span>
            {t('sizes.node.memLimit')} {pctCell(v.limitPct, 100)}
          </span>
        </Stack>
      </Box>
    </Box>
  );
}

/** 노드별 남은 자리 서랍(1B·§4-5 화면). 노드마다 한 덩어리, 맨 위는 모든 노드의 합(2026-10-30 다시 짬: 표 → 덩어리, 전체 용량 추가) */
export function CapacityPanel({ now = Date.now() }: { now?: number }) {
  const q = useCapacity(true);
  const d = q.data;
  if (q.isLoading) return <LinearProgress aria-label={t('common.loading')} />;
  if (q.error || d?.state === 'error')
    return (
      <Alert severity="error" action={<Button size="small" color="inherit" onClick={() => void q.refetch()} sx={focusSx}>{t('sizes.retry')}</Button>}>
        {q.error ? (q.error as Error).message : t('sizes.card.error')}
      </Alert>
    );
  if (!d || d.state === 'unknown' || !d.pod) return <Alert severity="info">{t('sizes.node.unknown')}</Alert>;
  if (!d.by_node.length) return <Alert severity="warning">{t('sizes.node.none')}</Alert>;
  return (
    <Stack spacing={2}>
      {d.state === 'stale' && <Alert severity="warning">{t('sizes.node.stale', { ago: ago(d.checked_at, now) })}</Alert>}
      {d.quota_limited && <Alert severity="warning">{t('sizes.node.quota', { n: d.slots ?? 0 })}</Alert>}
      <Box role="list" aria-label={t('sizes.node.title')}>
        {[sumNodes(d.by_node, d.slots ?? 0), ...d.by_node.map(fromNode)].map((v, i) => (
          <Box role="listitem" key={i === 0 ? '*' : v.name} sx={{ borderTop: i > 1 ? 1 : 0, borderBottom: i === 0 ? 2 : 0, borderColor: 'divider', mb: i === 0 ? 0.5 : 0 }}>
            <NodeBlock v={v} all={i === 0} />
          </Box>
        ))}
      </Box>
      <Box sx={{ color: 'text.secondary', typography: 'caption', display: 'grid', gap: 0.5, ...tabular }}>
        <span>{t('sizes.node.basis', { cpu: fmtUnit(d.pod.cpu), mem: fmtUnit(d.pod.memory / GIB), ago: d.checked_at ? ago(d.checked_at, now) : '—' })}</span>
        <span>
          {[t('sizes.node.people', { n: d.slots ?? 0 }), d.pending?.count ? t('sizes.node.pending', { n: d.pending.count }) : '', d.suspended ? t('sizes.node.suspended', { n: d.suspended }) : '']
            .filter(Boolean)
            .join(' · ')}
        </span>
        <span>{t('sizes.node.nfs')}</span>
      </Box>
    </Stack>
  );
}

/** 확인 창(DrawerActions 의 확인 모양: 글뿐 아니라 목록을 넣고, 확인은 Tier 1·위험은 Tier 3, 실패는 창 안에). useConfirm 은 글자만 받아 쓰지 않는다(§4-7) */
export function SizeDialog({
  open,
  title,
  message,
  okLabel,
  danger,
  onConfirm,
  onClose,
}: {
  open: boolean;
  title: string;
  message: ReactNode;
  okLabel: string;
  danger?: boolean;
  onConfirm: () => Promise<void>;
  onClose: () => void;
}) {
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const titleId = useId();
  const fullScreen = useMediaQuery(useTheme().breakpoints.down('sm'));
  const close = () => {
    setBusy(false);
    setError('');
    onClose();
  };
  const ok = async () => {
    setBusy(true);
    setError('');
    try {
      await onConfirm();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
      return;
    }
    close();
  };
  return (
    <Dialog open={open} onClose={busy ? undefined : close} aria-labelledby={titleId} fullWidth maxWidth="sm" fullScreen={fullScreen}>
      <DialogTitle id={titleId}>{title}</DialogTitle>
      <DialogContent>
        <DialogContentText component="div">{message}</DialogContentText>
        {error && (
          <Alert severity="error" sx={{ mt: 2 }}>
            {error}
          </Alert>
        )}
      </DialogContent>
      <DialogActions>
        <Button variant="outlined" color="inherit" sx={tier2} onClick={close} disabled={busy}>
          {t('common.cancel')}
        </Button>
        <Button variant="outlined" color="inherit" sx={danger ? tier3 : tier1} onClick={() => void ok()} disabled={busy} startIcon={busy ? <CircularProgress size={14} color="inherit" /> : undefined}>
          {okLabel}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

const unitOf = (f: SizeField) => (kindOf(f) === 'cpu' ? t('sizes.unit.cpu') : 'GiB');
/** 「CPU 요청 0.5개」 */
export const fieldText = (f: SizeField, q?: string | null) => (q ? `${t(`sizes.field.${f}`)} ${displayQty(kindOf(f), q)}${unitOf(f)}` : '');

/** 표의 크기 칸(4A): spec 에 정한 칸만, 없으면 「기본」 */
export const sizeShort = (size?: SizeValues | null) =>
  SIZE_FIELDS.map((f) => fieldText(f, size?.[f]))
    .filter(Boolean)
    .join(' · ') || t('sizes.default');

/** 서랍 KV 「크기」(§4-7): spec 칸, 없으면 설치값. 요청과 한도를 나눠 보인다 */
export function sizeKv(size: SizeValues | undefined, install: SizeValues | null | undefined, pvc?: string | null): string {
  const v = (f: SizeField) => size?.[f] || install?.[f] || null;
  const show = (f: SizeField) => (v(f) ? `${displayQty(kindOf(f), v(f))}${unitOf(f)}` : '—');
  return [
    t('sizes.kv.cpu', { req: show('cpu_request'), lim: show('cpu_limit') }),
    t('sizes.kv.memory', { req: show('memory_request'), lim: show('memory_limit') }),
    t('sizes.kv.pvc', { size: show('storage') }) + (pvc ? t('sizes.kv.pvcActual', { size: `${displayQty('memory', pvc)}GiB` }) : ''),
  ].join(' / ');
}

type Draft = Record<SizeField, string>;
const draftOf = (v: SizeValues): Draft => Object.fromEntries(SIZE_FIELDS.map((f) => [f, displayQty(kindOf(f), v[f])])) as Draft;

/** 막대 눈금(2의 거듭제곱). 칩 대신 막대를 끌어 고른다(2026-10-30 디자인 다시 짬). 눈금 밖의 값은 끝에 붙여 보인다 */
const SCALE: Record<'cpu' | 'memory', number[]> = { cpu: [0.5, 1, 2, 4, 8], memory: [1, 2, 4, 8, 16] };
const STORAGE_CHIPS = [5, 10, 20, 50];

/** 숫자 칸 하나: 보이는 label 은 「요청」·「한도」·「크기」, 접근 이름은 「CPU 요청, 개」(6B). 안내 글은 오류일 때만 */
function QtyField({ field, part, value, onChange, inherited, error, inputRef }: { field: SizeField; part: string; value: string; onChange: (v: string) => void; inherited: string | null; error?: string; inputRef: (el: HTMLInputElement | null) => void }) {
  const kind = kindOf(field);
  const unit = unitOf(field);
  return (
    <TextField
      size="small"
      type="number"
      fullWidth
      label={part}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={inherited ? t('sizes.placeholder', { v: displayQty(kind, inherited) }) : ''}
      error={!!error}
      helperText={error}
      inputRef={inputRef}
      slotProps={{
        input: { endAdornment: <InputAdornment position="end">{unit}</InputAdornment> },
        htmlInput: { step: kind === 'cpu' ? 0.05 : 0.25, min: 0, 'aria-label': `${t(`sizes.field.${field}`)}, ${unit}`, style: tabular, 'data-size-input': field },
        inputLabel: { shrink: true },
      }}
    />
  );
}

/** 요청~한도 막대(두 손잡이). 직접 정한 칸은 속이 찬 점, 비워서 기본값을 따르는 칸은 속이 빈 점이다. 요청이 한도를 넘어 끌리지 않는다 */
function RangeBar({ kind, req, lim, onReq, onLim }: { kind: 'cpu' | 'memory'; req: { v: number | null; own: boolean }; lim: { v: number | null; own: boolean }; onReq: (v: string) => void; onLim: (v: string) => void }) {
  const scale = SCALE[kind];
  const min = Math.log2(scale[0]);
  const max = Math.log2(scale[scale.length - 1]);
  const pos = (v: number | null) => (v == null || v <= 0 ? min : Math.min(max, Math.max(min, Math.log2(v))));
  const unit = kind === 'cpu' ? t('sizes.unit.cpu') : 'GiB';
  const hollow = { bgcolor: 'background.paper', border: '2px solid', borderColor: 'text.secondary' };
  return (
    <Box sx={{ px: 1.25, pt: 0.5 }}>
      <Slider
        size="small"
        value={[pos(req.v), pos(lim.v)]}
        min={min}
        max={max}
        step={null}
        marks={scale.map((v) => ({ value: Math.log2(v), label: fmtUnit(v) }))}
        disableSwap
        onChange={(_, v, active) => (active === 0 ? onReq : onLim)(fmtUnit(2 ** (v as number[])[active]))}
        getAriaLabel={(i) => t(`sizes.field.${kind}_${i === 0 ? 'request' : 'limit'}`)}
        getAriaValueText={(v) => `${fmtUnit(2 ** v)}${unit}`}
        sx={{
          color: 'text.primary',
          height: 4,
          py: 1.25,
          '& .MuiSlider-rail': { bgcolor: 'divider', opacity: 1 },
          '& .MuiSlider-track': { border: 0 },
          '& .MuiSlider-mark': { bgcolor: 'text.disabled', width: 2, height: 6, borderRadius: 1 },
          '& .MuiSlider-markActive': { bgcolor: 'background.paper', opacity: 0.8 },
          '& .MuiSlider-markLabel': { typography: 'caption', color: 'text.secondary', top: 22, ...tabular },
          '& .MuiSlider-thumb': { width: 14, height: 14, boxShadow: 'none', '&:hover, &.Mui-active': { boxShadow: 'none' } },
          '& .MuiSlider-thumb.Mui-focusVisible': { boxShadow: 'none', outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2 },
          ...(req.own ? {} : { '& .MuiSlider-thumb[data-index="0"]': hollow }),
          ...(lim.own ? {} : { '& .MuiSlider-thumb[data-index="1"]': hollow }),
          mb: 2,
        }}
      />
    </Box>
  );
}

/** 자원 한 줄: 왼쪽에 자원 이름과 따라갈 기본값, 오른쪽에 칸·막대. 600px 미만은 위아래로 */
function ResourceRow({ name, base, children, testId }: { name: string; base: string; children: ReactNode; testId: string }) {
  return (
    <Box
      data-size-row={testId}
      sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', sm: '120px 1fr' }, columnGap: 3, rowGap: 1, py: 2, borderTop: 1, borderColor: 'divider', '&:first-of-type': { borderTop: 0, pt: 0.5 } }}
    >
      <Box sx={{ pt: { sm: 1 } }}>
        <Typography variant="subtitle2" component="div">
          {name}
        </Typography>
        <Typography variant="caption" color="text.secondary" sx={tabular}>
          {base}
        </Typography>
      </Box>
      <Box sx={{ minWidth: 0 }}>{children}</Box>
    </Box>
  );
}

export interface SizeTarget {
  name: string;
  label: string;
  busy?: boolean;
}

interface SaveResult {
  ok: boolean;
  rollout?: string;
  after_rollout?: boolean;
  warnings: string[];
  targets: string[];
}

/** 크기 다섯 칸과 저장(1A·1D·2B·3A·5A). scope 는 '*'(관리자 기본값) 또는 사람 이메일. 사람이면 저장 전에 다시 만들어질 작업공간을 보인다 */
export function SizeForm({ scope, sizes, targets = [], owner, onSaved }: { scope: string; sizes: SizesData; targets?: SizeTarget[]; owner?: string; onSaved?: () => void }) {
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const admin = scope === '*';
  const saved = admin ? sizes.admin : (sizes.people[scope] ?? BLANK);
  const install = sizes.install;
  const [original, setOriginal] = useState<SizeValues>(saved);
  const [draft, setDraft] = useState<Draft>(() => draftOf(saved));
  const [errors, setErrors] = useState<Partial<Record<SizeField, string>>>({});
  const [blocked, setBlocked] = useState<BlockedInfo | null>(null);
  const [warnings, setWarnings] = useState<string[]>([]);
  const [error, setError] = useState('');
  const [retry, setRetry] = useState<string[]>([]);
  const [ask, setAsk] = useState<'confirm' | 'force' | null>(null);
  const [busy, setBusy] = useState(false);
  const refs = useRef<Partial<Record<SizeField, HTMLInputElement | null>>>({});

  const inherited = (f: SizeField) => (admin ? install?.[f] : sizes.admin[f] || install?.[f]) ?? null;
  // 「비우면 …」은 칸마다 되풀이하지 않고 맨 위 한 줄로(2026-10-30 디자인 다시 짬). 줄 왼쪽에 따라갈 값을 보인다
  const legend = !SIZE_FIELDS.some((f) => inherited(f)) ? t('sizes.legend.unknown') : t(admin ? 'sizes.legend.install' : 'sizes.legend.admin');
  const shownOf = (f: SizeField) => displayQty(kindOf(f), inherited(f)) || '—';
  const base = (k: 'cpu' | 'memory') => t('sizes.base', { req: shownOf(`${k}_request`), lim: shownOf(`${k}_limit`), unit: unitOf(`${k}_request`) });
  const values = () => Object.fromEntries(SIZE_FIELDS.map((f) => [f, draftToQty(kindOf(f), draft[f], original[f])])) as Record<SizeField, string | null | undefined>;
  const merged = (v: Record<SizeField, string | null | undefined>) => (f: SizeField) => v[f] || inherited(f);
  const now = values();
  const m = merged(now);
  // 「이 크기로 n개 더」(§4-5 화면): 서버가 같은 ConfigMap 으로 다시 센다
  const preview = useQuery<CapacityData>({
    queryKey: ['agent-capacity', m('cpu_request'), m('memory_request')],
    queryFn: () => get<CapacityData>(capacityUrl(m('cpu_request'), m('memory_request'))),
    retry: false,
    staleTime: 15000,
  });

  const focusFirst = (errs: Partial<Record<SizeField, string>>) => {
    const first = SIZE_FIELDS.find((f) => errs[f]);
    if (first) setTimeout(() => refs.current[first]?.focus(), 0);
  };
  const check = (): Record<SizeField, string | null> | null => {
    const v = values();
    const errs: Partial<Record<SizeField, string>> = {};
    for (const f of SIZE_FIELDS) if (v[f] === undefined) errs[f] = t('sizes.error.number');
    const mm = merged(v);
    for (const k of ['cpu', 'memory'] as const) {
      const r = parseQty(mm(`${k}_request`));
      const l = parseQty(mm(`${k}_limit`));
      if (r != null && l != null && r > l + 1e-9 && !errs[`${k}_request`]) errs[`${k}_request`] = t('sizes.error.order');
    }
    setErrors(errs);
    if (Object.keys(errs).length) {
      focusFirst(errs);
      return null;
    }
    return v as Record<SizeField, string | null>;
  };

  const send = async (force: boolean) => {
    const v = check();
    if (!v) return;
    setBusy(true);
    setError('');
    setRetry([]);
    try {
      const r = await post<SaveResult>('/api/agents/size', { email: scope, ...v, ...(force ? { force: true } : {}) });
      setBlocked(null);
      setWarnings(r.warnings ?? []);
      setOriginal(v);
      enqueueSnackbar(
        admin
          ? t('sizes.savedAdmin')
          : r.after_rollout
            ? t('sizes.savedAfterRollout', { owner: owner || scope })
            : t('sizes.savedPerson', { owner: owner || scope, n: r.targets.length }),
        { variant: 'success' }
      );
      await qc.invalidateQueries({ predicate: (k) => ['hermes-agents', 'agent-sizes', 'agent-capacity'].includes(String(k.queryKey[0])) });
      if (!r.warnings?.length) onSaved?.();
    } catch (e) {
      const data = e instanceof ApiError ? e.data : {};
      if (e instanceof ApiError && e.status === 409 && data.blocked) {
        setBlocked(data.blocked as BlockedInfo);
        setWarnings((data.warnings as string[]) ?? []);
      } else if (e instanceof ApiError && e.field && (SIZE_FIELDS as string[]).includes(e.field)) {
        const errs = { [e.field]: e.message } as Partial<Record<SizeField, string>>;
        setErrors(errs);
        focusFirst(errs);
      } else {
        setError((e as Error).message);
        if (data.saved) setRetry((data.targets as string[]) ?? targets.map((x) => x.name)); // 값은 저장했고 크기 롤아웃만 못 만들었다(2B 부분 실패)
      }
    } finally {
      setBusy(false);
    }
  };
  const reapply = async () => {
    setError('');
    try {
      await post('/api/agents/size/apply', { names: retry });
      setRetry([]);
      enqueueSnackbar(t('sizes.applyStarted', { n: retry.length }), { variant: 'success' });
      await qc.invalidateQueries({ queryKey: ['hermes-agents'] });
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const save = () => {
    if (!check()) return;
    if (!admin && targets.length) setAsk('confirm');
    else void send(false);
  };
  const p = preview.data;
  const more = preview.isLoading ? '…' : p && (p.state === 'ok' || p.state === 'stale') && p.slots != null ? t('sizes.preview', { n: p.slots }) : t('sizes.previewUnknown');
  const set = (f: SizeField) => (v: string) => {
    setDraft((d) => ({ ...d, [f]: v }));
    setErrors((e) => ({ ...e, [f]: undefined }));
  };
  const field = (f: SizeField, part: string) => (
    <QtyField
      field={f}
      part={part}
      value={draft[f]}
      onChange={set(f)}
      inherited={inherited(f)}
      error={errors[f]}
      inputRef={(el) => {
        refs.current[f] = el;
      }}
    />
  );
  // 막대 위치: 적은 값, 없으면 따라갈 값
  const point = (f: SizeField) => {
    const own = draft[f].trim() !== '' && Number(draft[f]) > 0;
    return { v: own ? Number(draft[f]) : toUnit(kindOf(f), inherited(f)), own };
  };
  const pair = (k: 'cpu' | 'memory') => (
    <ResourceRow name={t(`sizes.res.${k}`)} base={base(k)} testId={k}>
      <Box sx={{ display: 'grid', gap: 1.5, gridTemplateColumns: '1fr 1fr' }}>
        {field(`${k}_request`, t('sizes.part.request'))}
        {field(`${k}_limit`, t('sizes.part.limit'))}
      </Box>
      <RangeBar kind={k} req={point(`${k}_request`)} lim={point(`${k}_limit`)} onReq={set(`${k}_request`)} onLim={set(`${k}_limit`)} />
    </ResourceRow>
  );
  const list = (
    <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
      {targets.map((x) => (
        <li key={x.name}>
          {x.label}
          {x.busy && <Pill>{t('sizes.busy')}</Pill>}
        </li>
      ))}
    </Box>
  );
  return (
    <Stack spacing={1.5} data-size-form={scope}>
      <Typography variant="body2" color="text.secondary">
        {legend}
      </Typography>
      {/* 자원마다 한 줄: 요청·한도를 한 쌍으로 두고 그 사이를 막대로 보인다. PVC 는 칸 하나와 빠른 값 */}
      <Box>
        {pair('cpu')}
        {pair('memory')}
        <ResourceRow name={t('sizes.res.storage')} base={t('sizes.baseOne', { v: shownOf('storage'), unit: 'GiB' })} testId="storage">
          <Stack direction={{ xs: 'column', sm: 'row' }} spacing={1.5} alignItems={{ sm: 'flex-start' }}>
            <Box sx={{ width: { xs: '100%', sm: 'calc(50% - 6px)' }, flexShrink: 0 }}>{field('storage', t('sizes.part.size'))}</Box>
            <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ pt: { sm: 0.25 } }} role="group" aria-label={t('sizes.chips', { label: t('sizes.field.storage') })}>
              {STORAGE_CHIPS.map((c) => {
                const on = draft.storage.trim() !== '' && Number(draft.storage) === c;
                return (
                  <Button
                    key={c}
                    size="small"
                    variant="outlined"
                    color="inherit"
                    aria-pressed={on}
                    onClick={() => set('storage')(on ? '' : String(c))}
                    sx={(th) => ({ minWidth: 0, minHeight: { xs: 44, sm: 40 }, px: 1.25, py: 0, ...tabular, ...((on ? tier1 : tier2) as (x: Theme) => object)(th), ...focusSx })}
                  >
                    {`${c}GiB`}
                  </Button>
                );
              })}
            </Stack>
          </Stack>
          <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1, mb: 0 }}>
            {t('sizes.storageNote')}
          </Typography>
        </ResourceRow>
      </Box>
      <Box aria-live="polite">
        {blocked && (
          <Alert severity="warning" data-size-blocked="">
            <Typography variant="body2">{blocked.reason}</Typography>
            <Table size="small" sx={{ my: 1, '& td, & th': { px: 1 } }} aria-label={t('sizes.blockedNodes')}>
              <TableHead>
                <TableRow>
                  <TableCell>{t('sizes.node.name')}</TableCell>
                  <TableCell align="right">{t('sizes.node.freeCpu')}</TableCell>
                  <TableCell align="right">{t('sizes.node.freeMem')}</TableCell>
                </TableRow>
              </TableHead>
              <TableBody>
                {blocked.nodes.map((n) => (
                  <TableRow key={n.name}>
                    <TableCell>{n.name}</TableCell>
                    <TableCell align="right" sx={tabular}>{`${fmtUnit(n.free_cpu)}${t('sizes.unit.cpu')}`}</TableCell>
                    <TableCell align="right" sx={tabular}>{`${fmtUnit(n.free_memory / GIB)}GiB`}</TableCell>
                  </TableRow>
                ))}
              </TableBody>
            </Table>
            {warnings.length > 0 && (
              <Box component="ul" sx={{ m: 0, mb: 1, pl: 2.5 }}>
                {warnings.map((w) => (
                  <li key={w}>{w}</li>
                ))}
              </Box>
            )}
            <Button variant="outlined" color="inherit" size="small" sx={tier3} onClick={() => setAsk('force')} disabled={busy} data-size-force="">
              {t('sizes.force')}
            </Button>
          </Alert>
        )}
        {!blocked && warnings.length > 0 && (
          <Alert severity="warning">
            <Box component="ul" sx={{ m: 0, pl: 2.5 }}>
              {warnings.map((w) => (
                <li key={w}>{w}</li>
              ))}
            </Box>
          </Alert>
        )}
      </Box>
      {error && (
        <Alert
          severity="error"
          action={
            retry.length ? (
              <Button size="small" color="inherit" onClick={() => void reapply()} sx={focusSx}>
                {t('sizes.reapply')}
              </Button>
            ) : undefined
          }
        >
          {error}
        </Alert>
      )}
      <Stack direction="row" alignItems="center" justifyContent="space-between" spacing={2} useFlexGap flexWrap="wrap" sx={{ pt: 2, borderTop: 1, borderColor: 'divider' }}>
        <Typography variant="body2" aria-live="polite" data-size-preview="" sx={{ ...tabular, fontWeight: 600 }}>
          {more}
        </Typography>
        <Button variant="outlined" color="inherit" sx={tier1} onClick={save} disabled={busy} data-size-save="">
          {t('sizes.save')}
        </Button>
      </Stack>
      <SizeDialog
        open={ask === 'confirm'}
        title={t('sizes.confirmTitle')}
        message={
          <>
            {t('sizes.confirmPerson', { n: targets.length })}
            {list}
          </>
        }
        okLabel={t('sizes.save')}
        onConfirm={() => send(false)}
        onClose={() => setAsk(null)}
      />
      <SizeDialog
        open={ask === 'force'}
        title={t('sizes.force')}
        danger
        message={
          <>
            {t('sizes.forceConfirm', { n: blocked?.agents.length ?? 0 })}
            {list}
          </>
        }
        okLabel={t('sizes.force')}
        onConfirm={() => send(true)}
        onClose={() => setAsk(null)}
      />
    </Stack>
  );
}

/** 「기본 크기」 서랍(1D): 관리자 기본값 수정, 설치값 표시, 「이 크기로 n개 더」만 */
export function DefaultSizePanel({ onSaved }: { onSaved?: () => void }) {
  const q = useSizes(true);
  if (q.isLoading) return <LinearProgress aria-label={t('common.loading')} />;
  if (!q.data) return <Alert severity="error">{(q.error as Error | null)?.message ?? t('sizes.card.error')}</Alert>;
  // 설치값은 줄마다 「기본 …」으로 보이므로 따로 적지 않는다. 모를 때만 알린다
  return (
    <Stack spacing={2}>
      {!q.data.install && <Alert severity="info">{t('sizes.installUnknown')}</Alert>}
      <SizeForm scope="*" sizes={q.data} onSaved={onSaved} />
    </Stack>
  );
}

/** 새 주인의 크기가 지금 spec 과 달라 파드가 다시 만들어지는가(D8). 모르면 false */
export function ownerSizeChanges(sizes: SizesData | undefined, email: string, current: SizeValues | undefined): boolean {
  if (!sizes || !email.includes('@')) return false;
  const person = sizes.people[email.trim().toLowerCase()] ?? BLANK;
  const fields: SizeField[] = ['cpu_request', 'memory_request', 'cpu_limit', 'memory_limit'];
  return fields.some((f) => !sameQty(person[f] || sizes.admin[f] || sizes.install?.[f], current?.[f] || sizes.install?.[f]));
}


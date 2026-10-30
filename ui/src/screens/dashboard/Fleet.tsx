/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 대시보드 「전체 에이전트」 구역(관리자만). 값은 /api/dashboard — 리더 수집 바퀴가 DB 에 쌓은 것만 읽는다(계획 2026-10-14-014 R1).
// 순서는 숫자 줄 → 에이전트별 표(문제 수 내림차순) → 추이 → 운영 정보(디자인 DD11). 테두리는 표 하나에만(DD8).
import ListAltOutlinedIcon from '@mui/icons-material/ListAltOutlined';
import MonitorHeartOutlinedIcon from '@mui/icons-material/MonitorHeartOutlined';
import ShowChartOutlinedIcon from '@mui/icons-material/ShowChartOutlined';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import {
  Alert,
  Box,
  Button,
  Chip,
  Link as MuiLink,
  Table,
  TableBody,
  TableCell,
  TableContainer,
  TableHead,
  TableRow,
  Typography,
} from '@mui/material';
import { useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { lazy, ReactNode, Suspense, useMemo, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentChip } from '@/components/AgentChip';
import { UserChip } from '@/components/UserChip';
import { t } from '@/i18n';
import { Dashboard, DashPod, filterPods, hoursOld, PodFilter, sortPods } from '@/lib/dashboard';
import { fmtTs } from '@/lib/format';
import { switchPod } from '@/lib/pod';
import { gridTokens } from '@/lib/shellTokens';

import { Kpi, KpiRow, Placeholder, StatusPill, SubBody, SubHead } from './parts';
import { ChartSpec,chartSpecs } from './trendData';

/** 그래프 묶음을 못 받으면 같은 값을 표로 보인다(계획 §14). */
const TrendCharts = lazy(() => import('./TrendCharts').catch(() => ({ default: TrendTables })));

const FILTER_LABEL: Record<Exclude<PodFilter, 'all'>, string> = {
  failing: 'dashboard.filterFailing',
  profiles: 'dashboard.filterProfiles',
  collect: 'dashboard.filterCollect',
};

export function TrendTables({ specs }: { specs: ChartSpec[] }) {
  return (
    <Box sx={{ display: 'grid', gap: 2, gridTemplateColumns: { xs: '1fr', md: 'repeat(3, minmax(0, 1fr))' } }}>
      {specs.map((s) => (
        <TableContainer key={s.title} sx={{ maxHeight: 240 }}>
          <Table size="small" stickyHeader aria-label={s.title}>
            <TableHead>
              <TableRow>
                <TableCell>{t('dashboard.colDay')}</TableCell>
                {s.series.map((x) => (
                  <TableCell key={x.name} align="right">
                    {x.name}
                  </TableCell>
                ))}
              </TableRow>
            </TableHead>
            <TableBody>
              {s.days.map((d, i) => (
                <TableRow key={d}>
                  <TableCell>{d.slice(5)}</TableCell>
                  {s.series.map((x) => (
                    <TableCell key={x.name} align="right">
                      {x.values[i] ?? '—'}
                    </TableCell>
                  ))}
                </TableRow>
              ))}
            </TableBody>
          </Table>
        </TableContainer>
      ))}
    </Box>
  );
}

function CollectedCell({ p, now }: { p: DashPod; now: string }) {
  if (!p.ready) return <>{t('dashboard.preparingPhase', { phase: p.phase || '—' })}</>;
  if (!p.collected) return <>{t('dashboard.collectNever')}</>;
  if (!p.ok)
    return (
      <Typography component="span" variant="body2" color="warning.main" title={p.reason}>
        {p.ts ? t('dashboard.collectFailed', { ts: fmtTs(p.ts) }) : t('dashboard.collectFailedNoValue')}
      </Typography>
    );
  const old = hoursOld(p.checked, now);
  return old ? (
    <Typography component="span" variant="body2" color="warning.main">
      {t('dashboard.staleValue', { n: old })}
    </Typography>
  ) : (
    <>{fmtTs(p.checked)}</>
  );
}

/** 「메신저 연결」 칸: 연결된 메신저 / 전체. 게이트웨이가 실행 중이어도 메신저가 없으면 「연결 없음」(예전에는 게이트웨이 수를 보여 1/1 로 보였다) */
const messengers = (v: DashPod['values']): ReactNode =>
  !v || v.messengers_total == null || v.messengers_connected == null ? '—' : v.messengers_total === 0 ? t('dashboard.noMessengers') : `${v.messengers_connected}/${v.messengers_total}`;

const num = (v: number | undefined, tone?: 'bad' | 'warn'): ReactNode =>
  v == null ? '—' : v && tone ? <Box component="span" sx={{ color: tone === 'bad' ? 'error.main' : 'warning.main', fontWeight: 600 }}>{v}</Box> : v;

export function Fleet({ data, currentPod, onCurrent }: { data: Dashboard; currentPod?: string; onCurrent: () => void }) {
  const nav = useNavigate();
  const { enqueueSnackbar } = useSnackbar();
  const qc = useQueryClient();
  const [filter, setFilter] = useState<PodFilter>('all');
  const [asTable, setAsTable] = useState(false);
  const [switching, setSwitching] = useState<string | null>(null);
  const specs = useMemo(() => chartSpecs(data.trend, data.usage), [data.trend, data.usage]);
  const rows = useMemo(() => filterPods(sortPods(data.pods), filter), [data.pods, filter]);
  const tot = data.totals;
  const never = !data.pods.some((p) => p.collected);
  const kpi = (v: number): ReactNode => (never ? '—' : v);
  const narrow = (f: PodFilter) => () => setFilter(f);

  // 다른 에이전트 줄: /api/pod 로 바꾼 뒤 페이지를 다시 불러오지 않고 보고 있는 데이터만 다시 받아 「지금 에이전트」 구역으로 내려간다(R5·DD6, 2026-10-18).
  // 위쪽 새로고침 단추와 같은 방법(invalidateQueries)이라 화면 틀·스크롤·열린 서랍·표의 거름이 그대로 남는다. 지금 에이전트 줄은 그 구역으로 내려간다
  const open = async (p: DashPod) => {
    if (!p.ready || switching) return;
    if (p.id === currentPod) return onCurrent();
    setSwitching(p.id);
    try {
      await switchPod(p.id);
      // 내 정보(지금 에이전트)를 먼저 받아 「지금 보는 에이전트」 뱃지와 아래 구역 제목이 곧바로 옮겨 가게 한다. 나머지 데이터는 기다리지 않고 받는다.
      // 모두 한꺼번에 기다리면 느린 요청(새 에이전트의 상태·프로파일)이 끝날 때까지 뱃지가 옛 줄에 남았다
      await qc.refetchQueries({ queryKey: ['me'] });
      onCurrent();
      void qc.invalidateQueries({ predicate: (q) => q.queryKey[0] !== 'me' }); // 내 정보는 방금 받았다
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setSwitching(null);
    }
  };

  if (!data.pods.length)
    return (
      <Alert severity="info" action={<Button startIcon={<SmartToyOutlinedIcon />} onClick={() => nav('/agents')}>{t('dashboard.toAgents')}</Button>}>
        {t('dashboard.noAgents')}
      </Alert>
    );

  const ops = data.ops;
  const round = ops?.collect;
  return (
    <Box>
      <KpiRow>
        <Kpi n={`${tot.agents_ready}/${tot.agents_total}`} label={t('dashboard.kpiReady')} go={() => nav('/agents')} />
        <Kpi n={kpi(tot.failed_stalled)} label={t('dashboard.kpiFailed')} tone="bad" go={narrow('failing')} />
        <Kpi n={kpi(tot.profiles_bad)} label={t('dashboard.kpiProfiles')} tone="bad" go={narrow('profiles')} />
        <Kpi n={kpi(tot.creds_expiring)} label={t('dashboard.kpiCreds')} tone="warn" go={() => nav('/credentials?tab=flag')} />
      </KpiRow>
      {never ? (
        <Typography variant="body2" color="text.secondary" sx={{ mt: 0.5 }}>
          {t('dashboard.nextCollect', { ts: fmtTs(data.next_collect) })}
        </Typography>
      ) : (
        tot.failed > 0 && (
          // 합계는 이번 수집에 성공한 에이전트만 센다. 빠진 것을 밝히고, 누르면 표를 실패 줄로 거른다(DD5)
          <MuiLink component="button" variant="body2" color="warning.main" onClick={narrow('collect')} sx={{ mt: 0.5 }} data-partial="">
            {t('dashboard.partial', { total: tot.countable, counted: tot.counted, failed: tot.failed })}
          </MuiLink>
        )
      )}

      <SubHead
        icon={ListAltOutlinedIcon}
        right={
          filter !== 'all' && (
            <Chip
              size="small"
              label={t('dashboard.filterLabel', { what: t(FILTER_LABEL[filter]) })}
              onDelete={() => setFilter('all')}
              deleteIcon={<span aria-label={t('dashboard.filterClear')}>×</span>}
            />
          )
        }
      >
        {t('dashboard.tableTitle')}
      </SubHead>
      {/* 공용 표(DataGrid)와 같은 바탕·선·헤더·hover·선택 색(계획 2026-10-14-023). Paper 로 패널 색을 칠하지 않는다 */}
      <SubBody>
      <TableContainer
        sx={(th) => {
          const tk = gridTokens[th.palette.mode];
          return {
            overflowX: 'auto',
            bgcolor: tk.surface,
            border: `1px solid ${tk.barLine}`,
            borderRadius: 1,
            '& thead th': { backgroundColor: tk.head, color: tk.headText },
            '& tbody td': { borderBottomColor: tk.rowLine },
            '& tbody tr:last-of-type td': { borderBottom: 0 },
            // 첫 열은 가로로 스크롤될 때 아래 칸이 비치지 않게 불투명 값을 쓰고, 행 상태(hover·선택)를 따라간다
            '& .fleet-sticky': { position: 'sticky', left: 0, zIndex: 1, bgcolor: tk.surface },
            '& thead .fleet-sticky': { bgcolor: tk.headSolid, zIndex: 2 },
            // 눌러 열 수 있는 행(TableRow hover)만 hover 색을 받는다
            '& tbody tr.MuiTableRow-hover:hover': { bgcolor: tk.hover },
            '& tbody tr.MuiTableRow-hover:hover .fleet-sticky': { bgcolor: tk.hoverSolid },
            '& tbody tr.Mui-selected, & tbody tr.Mui-selected:hover': { bgcolor: tk.selected },
            '& tbody tr.Mui-selected .fleet-sticky': { bgcolor: tk.selectedSolid },
          };
        }}
      >
        <Table size="small" sx={{ minWidth: 820, '& th, & td': { whiteSpace: 'nowrap' } }}>
          <TableHead>
            <TableRow>
              <TableCell className="fleet-sticky">{t('dashboard.colName')}</TableCell>
              <TableCell>{t('dashboard.colOwner')}</TableCell>
              <TableCell>{t('dashboard.colReady')}</TableCell>
              <TableCell align="right">{t('dashboard.colGateway')}</TableCell>
              <TableCell align="right">{t('dashboard.colFailed')}</TableCell>
              <TableCell align="right">{t('dashboard.colProfiles')}</TableCell>
              <TableCell align="right">{t('dashboard.colCreds')}</TableCell>
              <TableCell>{t('dashboard.colLastDay')}</TableCell>
              <TableCell>{t('dashboard.colCollected')}</TableCell>
            </TableRow>
          </TableHead>
          <TableBody>
            {rows.map((p) => {
              const v = p.values;
              const press = p.ready && !switching;
              return (
                <TableRow
                  key={p.id}
                  hover={press}
                  data-pod={p.id}
                  selected={p.id === currentPod}
                  tabIndex={p.ready ? 0 : -1}
                  onClick={() => void open(p)}
                  onKeyDown={(e) => {
                    if (e.key === 'Enter') void open(p);
                  }}
                  sx={{ cursor: press ? 'pointer' : 'default', '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 } }}
                >
                  <TableCell className="fleet-sticky" sx={{ fontWeight: 500 }}>
                    <AgentChip name={p.name || p.id} colorKey={p.id} title={p.name ? p.id : undefined} size="sm" />
                    {switching === p.id && (
                      <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1 }}>
                        {t('dashboard.switching')}
                      </Typography>
                    )}
                    {p.id === currentPod && (
                      <Box component="span" sx={{ ml: 1 }}>
                        <StatusPill tone="info">{t('dashboard.currentRow')}</StatusPill>
                      </Box>
                    )}
                  </TableCell>
                  <TableCell>{p.owner ? <UserChip name={p.owner_name || undefined} email={p.owner} /> : '—'}</TableCell>
                  <TableCell>
                    {p.ready ? (
                      <StatusPill tone="good">{t('dashboard.ready')}</StatusPill>
                    ) : (
                      <StatusPill tone="warn">{t('dashboard.preparingPhase', { phase: p.phase || '—' })}</StatusPill>
                    )}
                  </TableCell>
                  <TableCell align="right">{messengers(v)}</TableCell>
                  <TableCell align="right">{num(v ? v.failed_jobs + v.stalled_jobs : undefined, 'bad')}</TableCell>
                  <TableCell align="right">{num(v?.profiles_bad, 'bad')}</TableCell>
                  <TableCell align="right">{num(v?.creds_expiring, 'warn')}</TableCell>
                  <TableCell>{p.last_day ?? '—'}</TableCell>
                  <TableCell>
                    <CollectedCell p={p} now={data.now} />
                  </TableCell>
                </TableRow>
              );
            })}
          </TableBody>
        </Table>
      </TableContainer>
      </SubBody>

      <SubHead
        icon={ShowChartOutlinedIcon}
        right={
          <Button size="small" onClick={() => setAsTable((v) => !v)}>
            {asTable ? t('dashboard.asChart') : t('dashboard.asTable')}
          </Button>
        }
      >
        {t('dashboard.trendTitle')}
      </SubHead>
      <SubBody>
      {!specs[0].days.length ? (
        <Typography variant="body2" color="text.secondary">
          {t('dashboard.trendEmpty')}
        </Typography>
      ) : asTable ? (
        <TrendTables specs={specs} />
      ) : (
        <Suspense fallback={<Placeholder height={140} />}>
          <TrendCharts specs={specs} />
        </Suspense>
      )}
      </SubBody>

      {ops && (
        <>
          <SubHead icon={MonitorHeartOutlinedIcon}>{t('dashboard.opsTitle')}</SubHead>
          <SubBody>
          <Typography variant="body2" color="text.secondary" data-ops="">
            {[
              t('dashboard.opsUsers', { n: ops.users }),
              ops.last_login ? t('dashboard.opsLastLogin', { ts: fmtTs(ops.last_login) }) : '',
              !ops.litellm ? t('dashboard.opsLitellmUnknown') : ops.litellm.reachable ? t('dashboard.opsLitellmOk') : t('dashboard.opsLitellmBad'),
              !ops.market ? '' : ops.market.alive ? t('dashboard.opsMarketOk') : t('dashboard.opsMarketBad'),
              round ? t('dashboard.opsRound', { ok: round.pods.ok, total: round.pods.total, s: round.seconds }) : '',
            ]
              .filter(Boolean)
              .join(' · ')}
          </Typography>
      </SubBody>
        </>
      )}
    </Box>
  );
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면의 에이전트 중심 보기: AI 에이전트 | 그 에이전트가 쓰는 스킬 | 고른 스킬의 동작·필요한 것·파일·게시.
// 스킬이 몇 개인지보다 「어느 에이전트의 어떤 스킬이 어떻게 도는가」를 먼저 보인다. POD 전체 표는 「모든 에이전트」 보기로 남긴다.
// 상태 값(켜짐·사용 기록·설정 필요·동작 형태)은 서버가 /api/skills 의 줄마다 붙인다(aas/assets/agent_skills.py).
import AddIcon from '@mui/icons-material/Add';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import SearchIcon from '@mui/icons-material/Search';
import TableRowsOutlinedIcon from '@mui/icons-material/TableRowsOutlined';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import {
  Alert,
  Box,
  Button,
  Chip,
  InputAdornment,
  LinearProgress,
  NativeSelect,
  Stack,
  Tab,
  Tabs,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
} from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { ReactNode, useEffect, useId, useMemo, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AiSummary } from '@/components/AiSummary';
import { ChatChip, KV, LinkChip, Mono, monoFont, Section, Tag } from '@/components/bits';
import { DisclosureButton } from '@/components/DisclosureButton';
import { PageTitle } from '@/components/PageTitle';
import { useFillHeight } from '@/components/useFillHeight';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { confLabel, kindLabel } from '@/lib/flowLabels';
import { FEdge, FNode, Graph } from '@/lib/flowLayout';
import { Splitter } from '@/screens/chat/layout';
import { AgentAvatar } from '@/screens/chat/parts';
import { Toggle } from '@/screens/profiles/Panes';
import { useProfileAct } from '@/screens/profiles/shared';
import { DownloadSkill } from '@/screens/skills/DownloadSkill';

export type Readiness = 'ok' | 'setup' | 'unused' | 'off';
export type RunMode = 'cron' | 'script' | 'mcp' | 'rest' | 'chat';

/** /api/skills 의 한 줄 중 이 보기가 쓰는 것. 상태 값은 옛 서버면 없다 */
export interface AgentSkillRow {
  id: string;
  name: string;
  profile: string;
  description?: string;
  origin?: string;
  shared_from?: string;
  n_cron: number;
  enabled?: boolean;
  uses?: number;
  last_used?: string;
  seen?: number;
  missing_env?: string[];
  modes?: RunMode[];
  readiness?: Readiness;
}
export interface AgentSummary {
  profile: string;
  skills: number;
  enabled: number;
  setup: number;
  unused: number;
  shared: number;
  cron: number;
  runs: number;
  last_run: string;
  last_used: string;
}
export interface AgentSkillsData {
  skills: AgentSkillRow[];
  agents?: AgentSummary[];
  primary?: string;
  profiles?: string[];
  can_upload?: boolean;
}
interface SkillOne {
  name: string;
  path: string;
  profile: string;
  origin?: string;
  shared_from?: string;
  description?: string;
  modified?: string;
  files: number;
  required_env?: { name: string; prompt?: string; help?: string; optional?: boolean; set?: boolean }[];
}

const FILTERS = ['all', 'on', 'off', 'setup', 'unused'] as const;
type Filter = (typeof FILTERS)[number];
const PANES = ['run', 'needs', 'files', 'publish'] as const;
type Pane = (typeof PANES)[number];
const LAYOUT_KEY = 'aas-skills-layout';
const LIMITS = { agents: [200, 360] as const, list: [300, 560] as const };

const agentLabel = (p: string) => (p === 'default' ? t('skills.shared') : p);
const readinessTone = (r?: Readiness) => (r === 'setup' ? 'warn' : r === 'ok' ? 'good' : undefined);
const shortDate = (s?: string) => (s ? s.slice(0, 10) : '');
const usedOf = (s: AgentSkillRow) => Math.max(s.uses ?? 0, s.seen ?? 0);
const matchFilter = (s: AgentSkillRow, f: Filter) =>
  f === 'all' ||
  (f === 'on' && s.enabled !== false) ||
  (f === 'off' && s.enabled === false) ||
  (f === 'setup' && s.readiness === 'setup') ||
  (f === 'unused' && s.readiness === 'unused');

function readLayout(): { agentsW: number; listW: number } {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') as { agentsW?: number; listW?: number };
    const clamp = (x: number | undefined, [lo, hi]: readonly [number, number], d: number) =>
      Math.min(hi, Math.max(lo, Number(x) || d));
    return { agentsW: clamp(v.agentsW, LIMITS.agents, 240), listW: clamp(v.listW, LIMITS.list, 400) };
  } catch {
    return { agentsW: 240, listW: 400 };
  }
}
function useLayout(): [{ agentsW: number; listW: number }, (p: Partial<{ agentsW: number; listW: number }>) => void] {
  const [v, setV] = useState(readLayout);
  return [
    v,
    (p) =>
      setV((prev) => {
        const next = { ...prev, ...p };
        try {
          localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
        } catch {
          /* 이번 화면에서만 */
        }
        return next;
      }),
  ];
}

/** 에이전트 목록 순서: 주 에이전트 → 이름순 → 공용(default) */
export function agentOrder(g: AgentSkillsData): string[] {
  const names = g.agents?.map((a) => a.profile) ?? [...new Set(g.skills.map((s) => s.profile))];
  return [...names].sort(
    (a, b) =>
      Number(a === 'default') - Number(b === 'default') ||
      Number(b === g.primary) - Number(a === g.primary) ||
      a.localeCompare(b)
  );
}

export function AgentSkills({
  g,
  onTable,
  onNew,
}: {
  g: AgentSkillsData;
  onTable: () => void;
  onNew: (profile: string) => void;
}) {
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery('(max-width:899.98px)');
  const [layout, setLayout] = useLayout();
  const { ref: frame, height } = useFillHeight<HTMLDivElement>();
  const order = agentOrder(g);
  const want = params.get('profile') ?? '';
  const agent = order.includes(want)
    ? want
    : (g.primary && order.includes(g.primary) ? g.primary : order[0]) ?? 'default';
  const skillId = params.get('skill') ?? '';
  const pane: Pane = (PANES as readonly string[]).includes(params.get('pane') ?? '')
    ? (params.get('pane') as Pane)
    : 'run';
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
        return next;
      },
      { replace: true }
    );
  useEffect(() => {
    if (want !== agent) set({ profile: agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, agent]);
  const rows = g.skills.filter((s) => s.profile === agent);
  const picked = rows.find((s) => s.id === skillId);
  const summary = g.agents?.find((a) => a.profile === agent);

  const agentsPanel = (
    <AgentColumn g={g} order={order} agent={agent} onPick={(p) => set({ profile: p, skill: null })} onTable={onTable} />
  );
  const listPanel = (
    <SkillColumn
      key={agent}
      agent={agent}
      rows={rows}
      summary={summary}
      selected={skillId}
      filter={(FILTERS as readonly string[]).includes(params.get('f') ?? '') ? (params.get('f') as Filter) : 'all'}
      onFilter={(f) => set({ f: f === 'all' ? null : f })}
      onPick={(id) => set({ skill: id })}
    />
  );
  const detail = picked ? (
    <SkillPanel
      key={picked.id}
      row={picked}
      pane={pane}
      onPane={(p) => set({ pane: p === 'run' ? null : p })}
      onBack={narrow ? () => set({ skill: null }) : undefined}
    />
  ) : (
    <Box sx={{ mt: 8, px: 3, textAlign: 'center' }}>
      <Typography color="text.secondary">{t('skillsAgent.pickSkill')}</Typography>
    </Box>
  );

  const title = (
    <PageTitle
      gutterBottom
      action={
        <Stack direction="row" spacing={1}>
          <Box component="span" data-guide="skills.new" sx={{ display: 'inline-flex' }}>
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              startIcon={<AddIcon />}
              onClick={() => onNew(agent)}
            >
              {t('skills.newSkill')}
            </Button>
          </Box>
          <Button size="small" color="inherit" startIcon={<TableRowsOutlinedIcon />} onClick={onTable}>
            {t('skillsAgent.allTable')}
          </Button>
        </Stack>
      }
    >
      {t('skills.title')}
    </PageTitle>
  );

  if (narrow)
    return (
      <Box data-testid="agent-skills">
        {title}
        {picked ? (
          detail
        ) : (
          <>
            <NativeSelect
              value={agent}
              onChange={(e) => set({ profile: e.target.value, skill: null })}
              inputProps={{ 'aria-label': t('skillsAgent.agents') }}
              sx={{ mb: 1 }}
            >
              {order.map((p) => (
                <option key={p} value={p}>
                  {agentLabel(p)}
                </option>
              ))}
            </NativeSelect>
            {listPanel}
          </>
        )}
      </Box>
    );
  return (
    <Box data-testid="agent-skills">
      {title}
      <Box
        ref={frame}
        sx={{
          display: 'grid',
          gridTemplateColumns: `${layout.agentsW}px 6px ${layout.listW}px 6px minmax(0, 1fr)`,
          gridTemplateRows: 'minmax(0, 1fr)',
          height: height ? `${height}px` : 'calc(100vh - 180px)',
          minHeight: 420,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ minHeight: 0, overflow: 'auto' }}>{agentsPanel}</Box>
        <Splitter
          label={t('skillsAgent.resizeAgents')}
          value={layout.agentsW}
          limits={LIMITS.agents}
          onChange={(v) => setLayout({ agentsW: v })}
        />
        <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{listPanel}</Box>
        <Splitter
          label={t('skillsAgent.resizeList')}
          value={layout.listW}
          limits={LIMITS.list}
          onChange={(v) => setLayout({ listW: v })}
        />
        <Box sx={{ minHeight: 0, minWidth: 0, overflow: 'auto', p: 2 }}>{detail}</Box>
      </Box>
    </Box>
  );
}

// ---- 왼쪽: AI 에이전트 -------------------------------------------------------------------------------

function AgentColumn({
  g,
  order,
  agent,
  onPick,
  onTable,
}: {
  g: AgentSkillsData;
  order: string[];
  agent: string;
  onPick: (p: string) => void;
  onTable: () => void;
}) {
  const byName = new Map((g.agents ?? []).map((a) => [a.profile, a]));
  return (
    <Box component="nav" aria-label={t('skillsAgent.agents')}>
      <Typography variant="overline" color="text.secondary" sx={{ px: 1.5, pt: 1, display: 'block' }}>
        {t('skillsAgent.agents')}
      </Typography>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {order.map((p) => {
          const a = byName.get(p);
          const own = g.skills.filter((s) => s.profile === p && !s.shared_from).length;
          const on = p === agent;
          return (
            <li key={p}>
              <Box
                component="button"
                type="button"
                aria-current={on ? 'true' : undefined}
                data-agent={p}
                onClick={() => onPick(p)}
                sx={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  width: '100%',
                  display: 'flex',
                  gap: 1.25,
                  alignItems: 'center',
                  px: 1.5,
                  py: 1,
                  cursor: 'pointer',
                  bgcolor: on ? 'action.selected' : undefined,
                  '&:hover': { bgcolor: on ? 'action.selected' : 'action.hover' },
                  '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
                }}
              >
                <AgentAvatar name={p} label={agentLabel(p)} size={32} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" alignItems="center" spacing={0.5}>
                    <Typography noWrap sx={{ fontWeight: on ? 600 : 500, fontSize: 14 }}>
                      {agentLabel(p)}
                    </Typography>
                    {p === g.primary && <Tag>{t('skillsAgent.primary')}</Tag>}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div" noWrap>
                    {a
                      ? t('skillsAgent.agentLine', { own, shared: a.shared, runs: a.runs })
                      : t('skillsAgent.agentLineOld', { n: g.skills.filter((s) => s.profile === p).length })}
                  </Typography>
                </Box>
                {!!a?.setup && (
                  <Tooltip title={t('skillsAgent.setupHint', { n: a.setup })}>
                    <Chip size="small" color="warning" variant="outlined" icon={<WarningAmberIcon />} label={a.setup} />
                  </Tooltip>
                )}
              </Box>
            </li>
          );
        })}
      </Box>
      <Box sx={{ px: 1.5, py: 1 }}>
        <Button size="small" color="inherit" startIcon={<TableRowsOutlinedIcon />} onClick={onTable}>
          {t('skillsAgent.allAgents')}
        </Button>
      </Box>
    </Box>
  );
}

// ---- 가운데: 그 에이전트의 스킬 ---------------------------------------------------------------------

function modeLabel(m: RunMode) {
  return t(`skillsAgent.mode.${m}`);
}

function SkillColumn({
  agent,
  rows,
  summary,
  selected,
  filter,
  onFilter,
  onPick,
}: {
  agent: string;
  rows: AgentSkillRow[];
  summary?: AgentSummary;
  selected: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onPick: (id: string) => void;
}) {
  const [q, setQ] = useState('');
  const [allShared, setAllShared] = useState(false);
  const needle = q.trim().toLowerCase();
  const hit = (s: AgentSkillRow) =>
    matchFilter(s, filter) && (!needle || `${s.name} ${s.description ?? ''}`.toLowerCase().includes(needle));
  const sorted = (list: AgentSkillRow[]) =>
    [...list].sort(
      (a, b) => Number(b.n_cron > 0) - Number(a.n_cron > 0) || usedOf(b) - usedOf(a) || a.name.localeCompare(b.name)
    );
  const own = sorted(rows.filter((s) => !s.shared_from && hit(s)));
  const sharedAll = sorted(rows.filter((s) => s.shared_from && hit(s)));
  // 공용에서 가져온 스킬은 많다(프로파일마다 백 개 넘게). 이 에이전트가 쓴 것만 먼저 보이고 나머지는 펼쳐서 본다
  const sharedUsed = sharedAll.filter((s) => s.readiness !== 'unused' || s.id === selected);
  const shared = allShared || needle || filter !== 'all' ? sharedAll : sharedUsed;
  const count = (f: Filter) => rows.filter((s) => matchFilter(s, f)).length;
  return (
    <>
      <Box sx={{ px: 1.5, pt: 1.25, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Typography sx={{ fontWeight: 600 }}>{t('skillsAgent.skillsOf', { name: agentLabel(agent) })}</Typography>
        {summary && (
          <Typography variant="caption" color="text.secondary" component="div">
            {t('skillsAgent.summary', {
              on: summary.enabled,
              n: summary.skills,
              cron: summary.cron,
              runs: summary.runs,
            })}
            {summary.last_used ? ' · ' + t('skillsAgent.lastUsed', { at: shortDate(summary.last_used) }) : ''}
          </Typography>
        )}
        <TextField
          size="small"
          fullWidth
          type="search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={t('skillsAgent.search')}
          sx={{ mt: 1 }}
          slotProps={{
            htmlInput: { 'aria-label': t('skillsAgent.search') },
            input: {
              startAdornment: (
                <InputAdornment position="start">
                  <SearchIcon fontSize="small" />
                </InputAdornment>
              ),
            },
          }}
        />
        <Stack
          direction="row"
          spacing={0.5}
          useFlexGap
          flexWrap="wrap"
          sx={{ mt: 1 }}
          role="group"
          aria-label={t('skillsAgent.filter')}
        >
          {FILTERS.map((f) => (
            <Chip
              key={f}
              size="small"
              label={`${t(`skillsAgent.filter.${f}`)} ${count(f)}`}
              color={filter === f ? 'primary' : 'default'}
              variant={filter === f ? 'filled' : 'outlined'}
              onClick={() => onFilter(f)}
              aria-pressed={filter === f}
            />
          ))}
        </Stack>
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <SkillGroup
          title={t('skillsAgent.ownSkills')}
          n={own.length}
          rows={own}
          agent={agent}
          selected={selected}
          onPick={onPick}
          empty={t('skillsAgent.ownEmpty')}
        />
        <SkillGroup
          title={t('skillsAgent.sharedSkills')}
          n={sharedAll.length}
          rows={shared}
          agent={agent}
          selected={selected}
          onPick={onPick}
          empty={sharedAll.length ? t('skillsAgent.sharedNoneUsed') : t('skillsAgent.sharedEmpty')}
          more={
            !allShared && !needle && filter === 'all' && sharedAll.length > sharedUsed.length ? (
              <Button size="small" color="inherit" onClick={() => setAllShared(true)}>
                {t('skillsAgent.sharedShowAll', { n: sharedAll.length - sharedUsed.length })}
              </Button>
            ) : undefined
          }
        />
      </Box>
    </>
  );
}

function SkillGroup({
  title,
  n,
  rows,
  agent,
  selected,
  onPick,
  empty,
  more,
}: {
  title: string;
  n: number;
  rows: AgentSkillRow[];
  agent: string;
  selected: string;
  onPick: (id: string) => void;
  empty: string;
  more?: ReactNode;
}) {
  return (
    <Box component="section" aria-label={title}>
      <Typography variant="overline" color="text.secondary" sx={{ px: 1.5, pt: 1, display: 'block' }}>
        {`${title} ${n}`}
      </Typography>
      {rows.length ? (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {rows.map((s) => (
            <SkillItem key={s.id} s={s} agent={agent} on={s.id === selected} onPick={() => onPick(s.id)} />
          ))}
        </Box>
      ) : (
        <Typography variant="body2" color="text.secondary" sx={{ px: 1.5, pb: 1 }}>
          {empty}
        </Typography>
      )}
      {more && <Box sx={{ px: 1, pb: 1 }}>{more}</Box>}
    </Box>
  );
}

function SkillItem({ s, agent, on, onPick }: { s: AgentSkillRow; agent: string; on: boolean; onPick: () => void }) {
  const used = usedOf(s);
  return (
    <Box
      component="li"
      data-skill={s.name}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 1,
        px: 1.5,
        py: 0.75,
        bgcolor: on ? 'action.selected' : undefined,
        borderLeft: 3,
        borderColor: on ? 'primary.main' : 'transparent',
        opacity: s.enabled === false ? 0.6 : 1,
      }}
    >
      <Box
        component="button"
        type="button"
        onClick={onPick}
        aria-current={on ? 'true' : undefined}
        sx={{
          all: 'unset',
          cursor: 'pointer',
          flex: 1,
          minWidth: 0,
          '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main' },
        }}
      >
        <Stack direction="row" spacing={0.75} alignItems="center" sx={{ minWidth: 0 }}>
          <Typography noWrap sx={{ fontWeight: 500, fontSize: 14 }}>
            {s.name}
          </Typography>
          {s.readiness && s.readiness !== 'ok' && (
            <Tag tone={readinessTone(s.readiness)}>{t(`skillsAgent.ready.${s.readiness}`)}</Tag>
          )}
        </Stack>
        <Stack direction="row" spacing={0.5} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mt: 0.25 }}>
          {(s.modes ?? []).map((m) => (
            <Box
              key={m}
              component="span"
              data-mode={m}
              sx={{ fontSize: 11, px: 0.75, borderRadius: 0.5, bgcolor: 'action.hover', color: 'text.secondary' }}
            >
              {modeLabel(m)}
            </Box>
          ))}
          <Typography variant="caption" color="text.secondary">
            {used ? t('skillsAgent.usedN', { n: used }) + (s.last_used ? ` · ${shortDate(s.last_used)}` : '') : ''}
          </Typography>
        </Stack>
      </Box>
      {s.enabled !== undefined && <SkillSwitch agent={agent} name={s.name} on={s.enabled} />}
    </Box>
  );
}

/** 켜기/끄기 — 프로필 화면의 스킬 패널과 같은 동작(대시보드 PUT /api/skills/toggle). 끄면 그 에이전트가 이 스킬을 못 쓴다 */
function SkillSwitch({ agent, name, on }: { agent: string; name: string; on: boolean }) {
  const { act } = useProfileAct(agent);
  const qc = useQueryClient();
  return (
    <Toggle
      key={String(on)}
      on={on}
      label={t('profiles.skillToggle', { name })}
      done={(next) => t(next ? 'profiles.skillOn' : 'profiles.skillOff', { name })}
      disabled={false}
      change={async (next) => {
        await act('skill', { target: name, enabled: next });
        await Promise.all([
          qc.invalidateQueries({ queryKey: ['skills'] }),
          qc.invalidateQueries({ queryKey: ['profile', agent] }),
        ]);
      }}
      offConfirm={t('profiles.skillOffConfirm', { name })}
    />
  );
}

// ---- 오른쪽: 고른 스킬 -------------------------------------------------------------------------------

function SkillPanel({
  row,
  pane,
  onPane,
  onBack,
}: {
  row: AgentSkillRow;
  pane: Pane;
  onPane: (p: Pane) => void;
  onBack?: () => void;
}) {
  const one = useQuery<SkillOne>({
    queryKey: ['skill', row.id],
    queryFn: () => get<SkillOne>('/api/skill?id=' + encodeURIComponent(row.id)),
  });
  const flow = useQuery<Graph>({
    queryKey: ['flow', 'skill:' + row.id],
    queryFn: () => get<Graph>('/api/flow?root=' + encodeURIComponent('skill:' + row.id)),
  });
  return (
    <Box data-testid="skill-panel">
      {onBack && (
        <Button size="small" startIcon={<ArrowBackIcon />} onClick={onBack} sx={{ mb: 1 }}>
          {t('skillsAgent.back')}
        </Button>
      )}
      <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
        <Typography variant="h6" component="h2" sx={{ fontSize: 18 }}>
          {row.name}
        </Typography>
        {row.origin && <Tag>{t(`skills.origin.${row.origin}`)}</Tag>}
        {row.shared_from && <Tag tone="info">{t('skillsAgent.sharedFrom', { name: agentLabel(row.shared_from) })}</Tag>}
        {row.readiness && <Tag tone={readinessTone(row.readiness)}>{t(`skillsAgent.ready.${row.readiness}`)}</Tag>}
      </Stack>
      {row.description && (
        <Typography variant="body2" sx={{ mt: 0.5 }}>
          {row.description}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
        {[
          t('skillsAgent.agentIs', { name: agentLabel(row.profile) }),
          row.enabled === false ? t('skillsAgent.ready.off') : t('skillsAgent.isOn'),
          usedOf(row) ? t('skillsAgent.usedN', { n: usedOf(row) }) : t('skillsAgent.neverUsed'),
          row.last_used ? t('skillsAgent.lastUsed', { at: shortDate(row.last_used) }) : '',
        ]
          .filter(Boolean)
          .join(' · ')}
      </Typography>
      <Tabs
        value={pane}
        onChange={(_e, v: Pane) => onPane(v)}
        sx={{ mt: 1, borderBottom: 1, borderColor: 'divider', minHeight: 40 }}
      >
        {PANES.map((p) => (
          <Tab key={p} value={p} label={t(`skillsAgent.pane.${p}`)} sx={{ minHeight: 40 }} />
        ))}
      </Tabs>
      <Box sx={{ pt: 2 }}>
        {pane === 'run' && <RunPane row={row} flow={flow.data} loading={flow.isLoading} error={flow.error?.message} />}
        {pane === 'needs' && <NeedsPane row={row} one={one.data} flow={flow.data} />}
        {pane === 'files' && <FilesPane row={row} one={one.data} />}
        {pane === 'publish' && <PublishPane row={row} one={one.data} />}
      </Box>
    </Box>
  );
}

const LANES: { id: string; kinds: string[] }[] = [
  { id: 'start', kinds: ['cron'] },
  { id: 'code', kinds: ['script'] },
  { id: 'tools', kinds: ['mcp', 'host', 'skill'] },
  { id: 'creds', kinds: ['cred'] },
  { id: 'libs', kinds: ['lib'] },
];

/** 「동작」: 시작 → 코드 → 도구 → 자격증명·라이브러리. 흐름 그림(/api/flow)을 띠로 접어 보인다. 연결마다 근거와 실행 관측 */
function RunPane({
  row,
  flow,
  loading,
  error,
}: {
  row: AgentSkillRow;
  flow?: Graph;
  loading: boolean;
  error?: string;
}) {
  if (loading) return <LinearProgress aria-label={t('skillsAgent.loading')} />;
  if (!flow) return <Alert severity="warning">{error ?? t('skillsAgent.noFlow')}</Alert>;
  const root = flow.root;
  const nodes = flow.nodes.filter((n) => n.id !== root);
  const edgeTo = (id: string) => flow.edges.filter((e) => e.to === id || (e.from === id && e.to === root));
  const used = usedOf(row);
  return (
    <Box>
      {flow.observed && !flow.observed.error && (
        <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
          {t('skillsAgent.observed', {
            days: flow.observed.days ?? 14,
            runs: flow.observed.runs,
            matched: flow.observed.matched,
          })}
        </Typography>
      )}
      <Box
        sx={{
          display: 'grid',
          gridTemplateColumns: 'repeat(auto-fit, minmax(190px, 1fr))',
          gap: 1.5,
          alignItems: 'start',
        }}
      >
        {LANES.map((lane) => {
          const items = nodes.filter((n) => lane.kinds.includes(n.kind));
          const chat = lane.id === 'start' && (row.modes?.includes('chat') || used > 0);
          if (!items.length && !chat && lane.id !== 'start') return null;
          return (
            <Box key={lane.id} component="section" aria-label={t(`skillsAgent.lane.${lane.id}`)} data-lane={lane.id}>
              <Typography variant="overline" color="text.secondary" sx={{ display: 'block', lineHeight: 1.6 }}>
                {`${t(`skillsAgent.lane.${lane.id}`)} ${items.length || ''}`}
              </Typography>
              <Stack spacing={1}>
                {chat && (
                  <NodeCard
                    label={t('skillsAgent.fromChat')}
                    sub={used ? t('skillsAgent.usedN', { n: used }) : t('skillsAgent.neverUsed')}
                    edges={[]}
                  />
                )}
                {!items.length && !chat && (
                  <Typography variant="body2" color="text.secondary">
                    {t('skillsAgent.noStart')}
                  </Typography>
                )}
                {items.map((n) => (
                  <NodeCard key={n.id} node={n} label={n.label} sub={n.sub || kindLabel(n.kind)} edges={edgeTo(n.id)} />
                ))}
              </Stack>
            </Box>
          );
        })}
      </Box>
      <Box sx={{ mt: 2 }}>
        <LinkChip to="flows" params={{ root: 'skill:' + row.id }} page={{ kind: 'skillMap', root: 'skill:' + row.id }}>
          {t('skills.viewFlow')}
        </LinkChip>
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t('skillsAgent.runNote')}
      </Typography>
    </Box>
  );
}

function NodeCard({ node, label, sub, edges }: { node?: FNode; label: string; sub: string; edges: FEdge[] }) {
  const [open, setOpen] = useState(false);
  const evId = useId();
  const evidence = edges.flatMap((e) => e.evidence).slice(0, 8);
  const observed = edges.reduce((n, e) => n + (e.meta.observed ?? 0), 0);
  const conf = edges
    .map((e) => e.conf)
    .sort(
      (a, b) =>
        ['config', 'code', 'doc', 'mention', 'observed'].indexOf(a) -
        ['config', 'code', 'doc', 'mention', 'observed'].indexOf(b)
    )[0];
  const bad = node?.status === 'bad';
  return (
    <Box
      sx={{
        border: 1,
        borderColor: bad ? 'error.main' : node?.status === 'warn' ? 'warning.main' : 'divider',
        borderRadius: 1,
        p: 1,
        minWidth: 0,
      }}
      data-node={node?.id}
    >
      <Typography sx={{ fontSize: 13, fontWeight: 500, wordBreak: 'break-all' }}>{label}</Typography>
      <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-all' }}>
        {sub}
      </Typography>
      <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>
        {conf && confLabel(conf) && (
          <Tooltip title={confLabel(conf)?.[1] ?? ''}>
            <Box component="span">
              <Tag>{confLabel(conf)?.[0]}</Tag>
            </Box>
          </Tooltip>
        )}
        {observed > 0 && <Tag tone="good">{t('flows.observedN', { count: observed })}</Tag>}
        {(node?.badges ?? []).slice(0, 2).map((b) => (
          <Tag key={b} tone={bad ? 'bad' : 'warn'}>
            {b}
          </Tag>
        ))}
      </Stack>
      {evidence.length > 0 && (
        <>
          <DisclosureButton
            open={open}
            onToggle={() => setOpen(!open)}
            controls={evId}
            label={open ? t('skillsAgent.hideEvidence') : t('skillsAgent.showEvidence', { n: evidence.length })}
            sx={{ mt: 0.5 }}
          />
          {open && (
            <Box component="ul" id={evId} sx={{ m: 0, pl: 2 }}>
              {evidence.map((x, i) => (
                <li key={i}>
                  <Typography component="div" sx={{ fontFamily: monoFont, fontSize: 11, wordBreak: 'break-all' }}>
                    {`${x.file}${x.line ? ':' + x.line : ''}`}
                  </Typography>
                  {x.text && (
                    <Typography
                      component="div"
                      color="text.secondary"
                      sx={{ fontFamily: monoFont, fontSize: 11, wordBreak: 'break-all' }}
                    >
                      {x.text}
                    </Typography>
                  )}
                </li>
              ))}
            </Box>
          )}
        </>
      )}
      {node?.link && (
        <Box sx={{ mt: 0.5 }}>
          <LinkChip to={node.link.view} params={node.link.params}>
            {t('skillsAgent.open')}
          </LinkChip>
        </Box>
      )}
    </Box>
  );
}

type Need = { key: string; kind: string; name: string; state: 'ok' | 'warn' | 'bad'; note: string; action?: ReactNode };

/** 「필요한 것」: 선언한 환경변수(그 에이전트 .env 기준) ∪ 코드가 쓰는 자격증명·MCP 서버·라이브러리. 값은 보이지 않는다 */
function NeedsPane({ row, one, flow }: { row: AgentSkillRow; one?: SkillOne; flow?: Graph }) {
  const needs: Need[] = [];
  const declared = new Set<string>();
  (one?.required_env ?? []).forEach((e) => {
    declared.add(e.name);
    needs.push({
      key: 'env:' + e.name,
      kind: t('skillsAgent.need.env'),
      name: e.name,
      state: e.set ? 'ok' : e.optional ? 'warn' : 'bad',
      note: [e.set ? t('skills.envSet') : e.optional ? t('skills.envOptional') : t('skills.envNeeded'), e.prompt]
        .filter(Boolean)
        .join(' · '),
      action: e.set ? undefined : (
        <LinkChip to="profiles" params={{ name: row.profile, pane: 'env', key: e.name }} page>
          {t('skills.envFill')}
        </LinkChip>
      ),
    });
  });
  (flow?.nodes ?? [])
    .filter((n) => n.kind === 'cred' || n.kind === 'mcp' || n.kind === 'lib')
    .forEach((n) => {
      if (n.kind === 'cred' && declared.has(n.label)) return;
      needs.push({
        key: n.id,
        kind: kindLabel(n.kind),
        name: n.label,
        state: n.status === 'bad' ? 'bad' : n.status === 'warn' ? 'warn' : 'ok',
        note: [n.sub, ...(n.badges ?? [])].filter(Boolean).join(' · '),
        action: n.link ? (
          <LinkChip to={n.link.view} params={n.link.params}>
            {t('skillsAgent.open')}
          </LinkChip>
        ) : undefined,
      });
    });
  const icon = (s: Need['state']) =>
    s === 'ok' ? (
      <CheckCircleOutlineIcon color="success" fontSize="small" />
    ) : s === 'warn' ? (
      <WarningAmberIcon color="warning" fontSize="small" />
    ) : (
      <ErrorOutlineIcon color="error" fontSize="small" />
    );
  const order = { bad: 0, warn: 1, ok: 2 };
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('skillsAgent.needsNote', { name: agentLabel(row.profile) })}
      </Typography>
      {needs.length ? (
        <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
          {[...needs]
            .sort((a, b) => order[a.state] - order[b.state])
            .map((n) => (
              <Box
                component="li"
                key={n.key}
                data-need={n.name}
                sx={{
                  display: 'flex',
                  gap: 1,
                  alignItems: 'flex-start',
                  py: 0.75,
                  borderBottom: 1,
                  borderColor: 'divider',
                }}
              >
                <Box sx={{ pt: 0.25 }}>{icon(n.state)}</Box>
                <Box sx={{ flex: 1, minWidth: 0 }}>
                  <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
                    <Mono>{n.name}</Mono>
                    <Typography variant="caption" color="text.secondary">
                      {n.kind}
                    </Typography>
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div" sx={{ wordBreak: 'break-all' }}>
                    {n.note}
                  </Typography>
                </Box>
                {n.action}
              </Box>
            ))}
        </Box>
      ) : (
        <Typography color="text.secondary">
          {one && flow ? t('skillsAgent.needsNone') : t('skillsAgent.loading')}
        </Typography>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t('skills.chatLoginNote')}
      </Typography>
    </Box>
  );
}

interface FileData {
  name: string;
  path: string;
  lines: string[];
  siblings?: string[];
}

/** 「파일」: SKILL.md 와 같은 폴더의 파일, 내려받기, AI 에이전트에게 설명·고치기 부탁 */
function FilesPane({ row, one }: { row: AgentSkillRow; one?: SkillOne }) {
  const path = one ? `${one.path}/SKILL.md` : '';
  const f = useQuery<FileData>({
    queryKey: ['file', path, 'siblings'],
    queryFn: () => get<FileData>(`/api/file?siblings=1&path=${encodeURIComponent(path)}`),
    enabled: !!path,
  });
  if (!one) return <LinearProgress aria-label={t('skillsAgent.loading')} />;
  const talkTo = row.profile;
  return (
    <Box>
      <KV
        pairs={[
          [t('skills.path'), <code key="p">{one.path}</code>],
          [t('skills.modified'), shortDate(one.modified)],
          [t('skills.files'), t('skills.fileCount', { count: one.files })],
        ]}
      />
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" sx={{ my: 1 }}>
        <ChatChip agent={talkTo} text={t('skills.explainPrompt', { name: one.name, path: one.path })}>
          {t('skills.explainAction')}
        </ChatChip>
        <ChatChip agent={talkTo} text={t('skills.editPrompt', { name: one.name, path: one.path })}>
          {t('skills.editAction')}
        </ChatChip>
      </Stack>
      {!one.shared_from && one.origin !== 'aas' && <DownloadSkill s={one} />}
      {!!f.data?.siblings?.length && (
        <Section title={t('skillsAgent.folderFiles')} count={f.data.siblings.length}>
          <Typography component="div" sx={{ fontFamily: monoFont, fontSize: 12 }}>
            {f.data.siblings.join('  ')}
          </Typography>
        </Section>
      )}
      <Section title="SKILL.md">
        {f.data ? (
          <Box
            component="pre"
            sx={{
              m: 0,
              p: 1.5,
              bgcolor: 'action.hover',
              borderRadius: 1,
              fontFamily: monoFont,
              fontSize: 12,
              whiteSpace: 'pre-wrap',
              wordBreak: 'break-word',
              maxHeight: 480,
              overflow: 'auto',
            }}
          >
            {f.data.lines.join('\n')}
          </Box>
        ) : f.error ? (
          <Alert severity="warning">{f.error.message}</Alert>
        ) : (
          <LinearProgress aria-label={t('skillsAgent.loading')} />
        )}
      </Section>
      <Section title={t('market.summary.title')}>
        <AiSummary target={{ id: row.id }} />
      </Section>
    </Box>
  );
}

interface CheckResult {
  ok: boolean;
  checks: { id: string; level: 'pass' | 'warn' | 'fail'; message: string }[];
  name: string;
  version: string;
  hub_version?: string;
  files: { path: string; size: number }[];
  excluded: string[];
  env: { declared: string[]; reads: Record<string, string[]>; undeclared: string[] };
  header: { before: string; after: string };
}
interface PublishList {
  items: {
    id: string;
    profile: string;
    path: string;
    name: string;
    version: string;
    status: string;
    message?: string;
  }[];
  can?: boolean;
}
const PUBLISHABLE = ['local', 'agent', 'bundled_modified', 'market'];

/** 「게시」: 점검 → 미리보기 → 게시 요청. 점검은 아무것도 저장하지 않는다(POST /api/market/publish/check). 승인 규칙은 그대로 */
function PublishPane({ row, one }: { row: AgentSkillRow; one?: SkillOne }) {
  const qc = useQueryClient();
  const { enqueueSnackbar } = useSnackbar();
  const list = useQuery<PublishList>({
    queryKey: ['market', 'publish'],
    queryFn: () => get<PublishList>('/api/market/publish'),
  });
  const [res, setRes] = useState<CheckResult | null>(null);
  const [name, setName] = useState('');
  const [version, setVersion] = useState('');
  const [busy, setBusy] = useState(false);
  // 공용에서 가져온 스킬은 원래 프로파일의 폴더를 올린다. 사용 기록은 이 에이전트 줄(id)로 본다
  const owner = row.shared_from ?? row.profile;
  const inRoot = (one?.path ?? '').replace(/^profiles\/[^/]+\//, '');
  const mine = useMemo(
    () => (list.data?.items ?? []).filter((r) => r.profile === owner && r.path === inRoot),
    [list.data, owner, inRoot]
  );
  if (!one || !list.data) return <LinearProgress aria-label={t('skillsAgent.loading')} />;
  if (!list.data.can) return <Alert severity="info">{t('skillsAgent.publishNoRight')}</Alert>;
  if (!one.origin || !PUBLISHABLE.includes(one.origin))
    return (
      <Alert severity="info">
        {t('skillsAgent.publishNotMine', { origin: t(`skills.origin.${one.origin ?? 'bundled'}`) })}
      </Alert>
    );
  const check = async (n = name, v = version) => {
    setBusy(true);
    try {
      const out = await post<CheckResult>('/api/market/publish/check', {
        id: row.id,
        profile: owner,
        path: inRoot,
        name: n.trim(),
        version: v.trim(),
      });
      setRes(out);
      setName(out.name);
      setVersion(out.version);
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const send = async () => {
    if (!res) return;
    setBusy(true);
    try {
      const out = await post<{
        request?: { auto?: string; auto_namespace?: string; auto_namespace_label?: string; auto_public?: boolean };
      }>('/api/market/publish', {
        profile: owner,
        path: inRoot,
        name: name.trim(),
        version: version.trim(),
        declare_env: res.env.undeclared,
      });
      const req = out?.request;
      enqueueSnackbar(
        req?.auto === 'pending'
          ? t('skills.publishAuto', {
              name: name.trim(),
              ns: req.auto_namespace_label ?? req.auto_namespace ?? '',
              vis: req.auto_public ? t('skills.visPublic') : t('skills.visMembers'),
            })
          : t('skills.publishRequested', { name: name.trim() }),
        { variant: 'success' }
      );
      setRes(null);
      await qc.invalidateQueries({ queryKey: ['market', 'publish'] });
    } catch (e) {
      enqueueSnackbar((e as Error).message, { variant: 'error' });
    } finally {
      setBusy(false);
    }
  };
  const levelIcon = (l: string) =>
    l === 'pass' ? (
      <CheckCircleOutlineIcon color="success" fontSize="small" />
    ) : l === 'warn' ? (
      <WarningAmberIcon color="warning" fontSize="small" />
    ) : (
      <ErrorOutlineIcon color="error" fontSize="small" />
    );
  const stale = res && (res.name !== name.trim() || res.version !== version.trim());
  return (
    <Box>
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('skillsAgent.publishIntro')}
      </Typography>
      {row.shared_from && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('skillsAgent.publishShared', { name: agentLabel(owner) })}
        </Alert>
      )}
      <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap" sx={{ mb: 1 }}>
        {res && (
          <>
            <TextField
              size="small"
              label={t('skills.publishName')}
              value={name}
              onChange={(e) => setName(e.target.value)}
              slotProps={{ htmlInput: { spellCheck: false } }}
            />
            <TextField
              size="small"
              label={t('skills.publishVersion')}
              value={version}
              onChange={(e) => setVersion(e.target.value)}
              sx={{ width: 110 }}
            />
          </>
        )}
        <Button variant={res ? 'text' : 'outlined'} disabled={busy} onClick={() => void check()}>
          {res ? t('skillsAgent.recheck') : t('skillsAgent.check')}
        </Button>
        {res && (
          <Button
            variant="contained"
            disableElevation
            disabled={busy || !res.ok || !!stale}
            onClick={() => void send()}
          >
            {t('skills.publishAsk')}
          </Button>
        )}
      </Stack>
      {busy && <LinearProgress aria-label={t('skillsAgent.checking')} sx={{ mb: 1 }} />}
      {stale && (
        <Typography variant="caption" color="warning.main" component="p">
          {t('skillsAgent.recheckHint')}
        </Typography>
      )}
      {res && (
        <>
          <Section title={t('skillsAgent.checks')}>
            <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }} data-testid="publish-checks">
              {res.checks.map((c, i) => (
                <Box
                  component="li"
                  key={c.id + i}
                  data-level={c.level}
                  sx={{ display: 'flex', gap: 1, alignItems: 'flex-start', py: 0.5 }}
                >
                  {levelIcon(c.level)}
                  <Typography variant="body2">{c.message}</Typography>
                </Box>
              ))}
            </Box>
          </Section>
          <Section title={t('skillsAgent.packageFiles')} count={res.files.length}>
            <Typography component="div" sx={{ fontFamily: monoFont, fontSize: 12 }}>
              {res.files.map((f) => `${f.path} (${Math.max(1, Math.round(f.size / 1024))}KiB)`).join('\n')}
            </Typography>
          </Section>
          <Section title={t('skillsAgent.headerPreview')}>
            <Box sx={{ display: 'grid', gridTemplateColumns: { xs: '1fr', lg: '1fr 1fr' }, gap: 1 }}>
              {(['before', 'after'] as const).map((k) => (
                <Box key={k}>
                  <Typography variant="caption" color="text.secondary">
                    {t(`skillsAgent.header.${k}`)}
                  </Typography>
                  <Box
                    component="pre"
                    data-header={k}
                    sx={{
                      m: 0,
                      p: 1,
                      bgcolor: 'action.hover',
                      borderRadius: 1,
                      fontFamily: monoFont,
                      fontSize: 12,
                      whiteSpace: 'pre-wrap',
                      wordBreak: 'break-word',
                    }}
                  >
                    {res.header[k] || '—'}
                  </Box>
                </Box>
              ))}
            </Box>
          </Section>
        </>
      )}
      {mine.length > 0 && (
        <Section title={t('skillsAgent.publishHistory')} count={mine.length}>
          {mine.map((r) => (
            <Typography key={r.id} variant="body2" color="text.secondary">
              {`${r.name}@${r.version} — ${t(`skills.publishStatus.${r.status}`)}${r.message ? ` (${r.message})` : ''}`}
            </Typography>
          ))}
        </Section>
      )}
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 1 }}>
        {t('skills.publishNote')}
      </Typography>
    </Box>
  );
}

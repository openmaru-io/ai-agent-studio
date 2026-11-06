/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스킬 화면의 에이전트 중심 보기: AI 에이전트 | 그 에이전트가 쓰는 스킬 | 고른 스킬의 동작·필요한 것·파일·게시.
// 스킬이 몇 개인지보다 「어느 에이전트의 어떤 스킬이 어떻게 도는가」를 먼저 보인다. POD 전체 표는 「모든 에이전트」 보기로 남긴다.
// 상태 값(켜짐·사용 기록·설정 필요·동작 형태)은 서버가 /api/skills 의 줄마다 붙인다(aas/assets/agent_skills.py).
// 화면 다듬기(스펙 2026-11-06-002 §8): 1280px 미만 아바타 띠 G12, 탭 G13, 게시 단계 G14, 에이전트 요약 G15, 에이전트 이름 G16,
// 켜고 끄기 G17, 자격증명 고칠 곳 링크 G18, 「등록됨」 중립색 G19.
// 개요 탭(기본 탭, AI 요약은 1.5초 머문 뒤)·머리의 「AI 에이전트별 | 전체 스킬」 전환·없는 에이전트 알림(스펙 2026-11-06-003 R1~R3).
import AccountTreeOutlinedIcon from '@mui/icons-material/AccountTreeOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import CheckCircleOutlineIcon from '@mui/icons-material/CheckCircleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import FolderSharedOutlinedIcon from '@mui/icons-material/FolderSharedOutlined';
import HelpOutlineIcon from '@mui/icons-material/HelpOutline';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import SearchIcon from '@mui/icons-material/Search';
import WarningAmberIcon from '@mui/icons-material/WarningAmber';
import type { SxProps, Theme } from '@mui/material';
import {
  Alert,
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  InputAdornment,
  LinearProgress,
  NativeSelect,
  Popover,
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
import { ReactNode, Suspense, useEffect, useId, useMemo, useRef, useState } from 'react';
import { Link as RouterLink, useSearchParams } from 'react-router-dom';

import { AddIconButton } from '@/components/AddIconButton';
import { AiSummary, useSummaryView } from '@/components/AiSummary';
import { ChatChip, KV, LinkChip, Mono, monoFont, Section, Tag } from '@/components/bits';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { languageOf } from '@/components/codeLanguage';
import { DisclosureButton } from '@/components/DisclosureButton';
import { LazyCodeEditor } from '@/components/LazyCodeEditor';
import { PageTitle } from '@/components/PageTitle';
import { tier1, tier2, tier3 } from '@/components/tierButton';
import { useFillHeight } from '@/components/useFillHeight';
import { t } from '@/i18n';
import { get, post } from '@/lib/api';
import { ChatGroup, ChatStatus, rowTitle } from '@/lib/chatStore';
import { confLabel, kindLabel } from '@/lib/flowLabels';
import { FEdge, FNode, Graph } from '@/lib/flowLayout';
import { badgeTone, serverTerm } from '@/lib/serverTerms';
import { FOCUS_RING } from '@/lib/shellTokens';
import { Splitter, STRIP_W } from '@/screens/chat/layout';
import { AgentAvatar } from '@/screens/chat/parts';
import { Toggle } from '@/screens/profiles/Panes';
import { useProfileAct } from '@/screens/profiles/shared';
import { BulkDeleteDialog, DeleteMode, useSkillDelete } from '@/screens/skills/DeleteSkill';
import { DownloadSkill } from '@/screens/skills/DownloadSkill';
import { SkillsViewToggle } from '@/screens/skills/SkillsViewToggle';

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
  /** 서버가 정한 지울 수 없는 이유(origin·same_name·name·in_use). 빈 값이면 지울 수 있다 */
  delete_block?: string;
  /** 이 스킬을 부르는 예약 작업·스킬 수(지우기를 막는다) */
  dependents_n?: number;
  /** 공용 스킬을 가져다 쓰는 AI 에이전트 수 */
  agents_n?: number;
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
// 「개요」가 맨 앞이고 기본 탭이다(스펙 2026-11-06-003 R1·D2). 기본 탭이면 주소에서 pane 을 지운다
const PANES = ['overview', 'run', 'needs', 'files', 'publish'] as const;
type Pane = (typeof PANES)[number];
const DEFAULT_PANE: Pane = 'overview';
/** 개요에서 요약을 스스로 만들기 전에 같은 스킬을 보고 있어야 하는 시간(D3) */
const SUMMARY_DWELL_MS = 1500;
/** 요약 대신 보이는 SKILL.md 앞부분 줄 수(빈 줄 빼고, D5·OV-L1) */
const EXCERPT_LINES = 15;
const LAYOUT_KEY = 'aas-skills-layout';
const LIMITS = { agents: [200, 360] as const, list: [300, 560] as const };

const agentLabel = (p: string) => (p === 'default' ? t('skills.shared') : p);

/** 에이전트를 채팅 화면과 같은 이름(예: 마케팅 도우미)으로 보인다(G16). 이름은 채팅과 같은 /api/chat/status?all=1 의 지금 묶음에서
 *  rowTitle 규칙으로 정한다. 읽지 못하면(옛 서버·채팅 설정 없음) 프로파일 이름 그대로 */
export function useAgentLabel(): (p: string) => string {
  const q = useQuery({
    queryKey: ['chat', 'status', 'names'],
    queryFn: () => get<{ groups?: ChatGroup[] } & ChatStatus>('/api/chat/status?all=1'),
    staleTime: 60_000,
    retry: false,
  });
  const g = q.data ? (q.data.groups?.find((x) => x.current) ?? q.data) : undefined;
  return (p: string) => {
    if (p === 'default' || !g?.agents?.length) return agentLabel(p);
    const a = g.agents.find((x) => x.name === p);
    return a ? rowTitle(g, a) : p;
  };
}
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

export function AgentSkills({ g, onNew }: { g: AgentSkillsData; onNew: (profile: string) => void }) {
  const [params, setParams] = useSearchParams();
  const narrow = useMediaQuery('(max-width:899.98px)');
  // 900~1279px 는 에이전트 칸을 아바타 띠로 접는다 — 채팅과 같은 규칙(G12). 세 칸이면 상세가 눌려 탭이 잘렸다
  const medium = useMediaQuery('(max-width:1279.98px)');
  const label = useAgentLabel();
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
    : DEFAULT_PANE;
  const set = (patch: Record<string, string | null>) =>
    setParams(
      (prev) => {
        const next = new URLSearchParams(prev);
        Object.entries(patch).forEach(([k, v]) => (v ? next.set(k, v) : next.delete(k)));
        return next;
      },
      { replace: true }
    );
  // 주소의 에이전트가 목록에 없으면(다른 작업공간의 에이전트 등) 주 에이전트로 바꾸고 한 번 알린다(D10).
  // 표 화면의 없는 프로파일 알림(useProfileScope)과 같은 방식 — 주소에 적혀 온 것만 알리고, 주소가 비어 있으면 조용히
  const { enqueueSnackbar } = useSnackbar();
  const told = useRef('');
  useEffect(() => {
    if (want === agent) return;
    if (want && told.current !== want) {
      told.current = want;
      enqueueSnackbar(t('skillsAgent.agentMissing', { name: want }), { variant: 'info' });
    }
    set({ profile: agent });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [want, agent]);
  const rows = g.skills.filter((s) => s.profile === agent);
  const picked = rows.find((s) => s.id === skillId);
  const summary = g.agents?.find((a) => a.profile === agent);
  // 지우기(DeleteSkill): 판정·확인 창·지우는 중 상태. 지운 스킬을 보고 있었으면 상세를 닫는다
  const del = useSkillDelete(g.skills, (s) => {
    if (s.id === skillId) set({ skill: null });
  });

  const agentsPanel = medium ? (
    <AgentStripSkills g={g} order={order} agent={agent} onPick={(p) => set({ profile: p, skill: null })} />
  ) : (
    <AgentColumn g={g} order={order} agent={agent} onPick={(p) => set({ profile: p, skill: null })} />
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
      modeOf={del.modeOf}
    />
  );
  const detail = picked ? (
    <SkillPanel
      key={picked.id}
      row={picked}
      pane={pane}
      onPane={(p) => set({ pane: p === DEFAULT_PANE ? null : p })}
      onBack={narrow ? () => set({ skill: null }) : undefined}
      mode={del.modeOf(picked)}
      onDelete={() => del.open(picked)}
    />
  ) : (
    <AgentOverview agent={agent} rows={rows} onPick={(id) => set({ skill: id, pane: 'needs' })} />
  );

  const title = (
    <PageTitle
      gutterBottom
      wrap
      action={
        <>
          {/* 「새 스킬」은 전체 스킬 화면과 같은 제목 옆 + 아이콘 단추(2026-11-06 사용자 지시) */}
          <Box component="span" data-guide="skills.new" sx={{ display: 'inline-flex' }}>
            <AddIconButton label={t('skills.newSkill')} onClick={() => onNew(agent)} />
          </Box>
          {/* 표 화면과 같은 자리·같은 부품(R2). 「전체 표」 단추를 대신한다 */}
          <SkillsViewToggle value="agent" />
          <Glossary />
        </>
      }
    >
      {t('skills.title')}
    </PageTitle>
  );

  if (narrow)
    return (
      <Box data-testid="agent-skills">
        {title}
        {del.dialog}
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
                  {label(p)}
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
      {del.dialog}
      <Box
        ref={frame}
        sx={{
          display: 'grid',
          gridTemplateColumns: medium
            ? `${STRIP_W}px ${layout.listW}px 6px minmax(0, 1fr)`
            : `${layout.agentsW}px 6px ${layout.listW}px 6px minmax(0, 1fr)`,
          gridTemplateRows: 'minmax(0, 1fr)',
          height: height ? `${height}px` : 'calc(100vh - 180px)',
          minHeight: 420,
          border: 1,
          borderColor: 'divider',
          borderRadius: 1,
          overflow: 'hidden',
        }}
      >
        <Box sx={{ minHeight: 0, overflow: 'auto', borderRight: medium ? 1 : 0, borderColor: 'divider' }}>{agentsPanel}</Box>
        {!medium && (
          <Splitter
            label={t('skillsAgent.resizeAgents')}
            value={layout.agentsW}
            limits={LIMITS.agents}
            onChange={(v) => setLayout({ agentsW: v })}
          />
        )}
        <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden' }}>{listPanel}</Box>
        <Splitter
          label={t('skillsAgent.resizeList')}
          value={layout.listW}
          limits={LIMITS.list}
          onChange={(v) => setLayout({ listW: v })}
        />
        <Box sx={{ minHeight: 0, minWidth: 0, overflow: 'auto' }} data-detail-scroll>
          {detail}
        </Box>
      </Box>
    </Box>
  );
}

// ---- 왼쪽: AI 에이전트 -------------------------------------------------------------------------------

/** 「기본」 칩: 주 에이전트 표시. 무엇이 기본인지 툴팁으로 설명한다(G16 — 「주」만으로는 뜻을 알 수 없었다) */
function PrimaryTag() {
  return (
    <Tooltip title={t('skillsAgent.primaryTip')}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <Tag>{t('skillsAgent.primary')}</Tag>
      </Box>
    </Tooltip>
  );
}

function AgentColumn({
  g,
  order,
  agent,
  onPick,
}: {
  g: AgentSkillsData;
  order: string[];
  agent: string;
  onPick: (p: string) => void;
}) {
  const label = useAgentLabel();
  const byName = new Map((g.agents ?? []).map((a) => [a.profile, a]));
  const agents = order.filter((p) => p !== 'default');
  const hasShared = order.includes('default');
  const sharedN = g.skills.filter((s) => s.profile === 'default' && !s.shared_from).length;
  const rowSx = (on: boolean): SxProps<Theme> => ({
    all: 'unset',
    boxSizing: 'border-box',
    width: '100%',
    display: 'flex',
    gap: 1.25,
    alignItems: 'center',
    px: 1.5,
    py: 1,
    cursor: 'pointer',
    borderLeft: 3,
    borderColor: on ? 'primary.main' : 'transparent',
    bgcolor: on ? 'action.selected' : 'transparent',
    '&:hover': { bgcolor: on ? 'action.selected' : 'action.hover' },
    '&:focus-visible': { outline: '2px solid', outlineColor: 'primary.main', outlineOffset: -2 },
  });
  return (
    <Box component="nav" aria-label={t('skillsAgent.agents')}>
      {/* 맨 위: 공용 스킬 — 에이전트 수와 무관하게 늘 스크롤 없이 보인다. 전체 보기는 제목 옆 전환(SkillsViewToggle) */}
      <Box
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 1,
          bgcolor: 'background.paper',
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {hasShared && (
          <Tooltip describeChild title={t('skillsAgent.sharedGroupHint')} placement="right">
            <Box
              component="button"
              type="button"
              aria-current={agent === 'default' ? 'true' : undefined}
              data-agent="default"
              onClick={() => onPick('default')}
              sx={rowSx(agent === 'default')}
            >
              <Box
                aria-hidden
                sx={{
                  width: 32,
                  height: 32,
                  borderRadius: 1,
                  display: 'grid',
                  placeItems: 'center',
                  bgcolor: 'info.main',
                  color: 'info.contrastText',
                  flexShrink: 0,
                }}
              >
                <FolderSharedOutlinedIcon fontSize="small" />
              </Box>
              <Box sx={{ minWidth: 0, flex: 1 }}>
                <Typography noWrap sx={{ fontWeight: 600, fontSize: 14 }}>
                  {t('skillsAgent.sharedGroup')}
                </Typography>
                <Typography variant="caption" color="text.secondary" component="div" noWrap>
                  {t('skillsAgent.sharedGroupLine', { n: sharedN })}
                </Typography>
              </Box>
              <SetupTag n={byName.get('default')?.setup ?? 0} />
            </Box>
          </Tooltip>
        )}
      </Box>
      <Typography variant="overline" color="text.secondary" sx={{ px: 1.5, pt: 1, display: 'block' }}>
        {`${t('skillsAgent.agents')} ${agents.length}`}
      </Typography>
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {agents.map((p) => {
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
                sx={rowSx(on)}
              >
                <AgentAvatar name={p} label={label(p)} size={32} />
                <Box sx={{ minWidth: 0, flex: 1 }}>
                  <Stack direction="row" alignItems="baseline" spacing={0.5} sx={{ minWidth: 0 }}>
                    <Typography noWrap sx={{ fontWeight: on ? 600 : 500, fontSize: 14, minWidth: 0 }}>
                      {label(p)}
                    </Typography>
                    {/* 채팅의 에이전트 줄처럼 이름이 프로파일과 다르면 프로파일 이름을 작게 */}
                    {label(p) !== agentLabel(p) && (
                      <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ flexShrink: 0 }}>
                        {p}
                      </Typography>
                    )}
                    {p === g.primary && <PrimaryTag />}
                  </Stack>
                  <Typography variant="caption" color="text.secondary" component="div" noWrap>
                    {a
                      ? t('skillsAgent.agentLine', { own, shared: a.shared })
                      : t('skillsAgent.agentLineOld', { n: g.skills.filter((s) => s.profile === p).length })}
                  </Typography>
                  {a && (
                    <Stack direction="row" spacing={0.75} alignItems="center" sx={{ mt: 0.25 }}>
                      <Typography variant="caption" color="text.secondary" noWrap>
                        {t('skillsAgent.recentRuns', { runs: a.runs })}
                      </Typography>
                      <SetupTag n={a.setup} />
                    </Stack>
                  )}
                </Box>
              </Box>
            </li>
          );
        })}
      </Box>
    </Box>
  );
}

/** 900~1279px 의 접힌 에이전트 칸: 아바타 띠(채팅 AgentStrip 과 같은 모양, G12). 배지는 설정이 필요한 스킬 수 */
function AgentStripSkills({
  g,
  order,
  agent,
  onPick,
}: {
  g: AgentSkillsData;
  order: string[];
  agent: string;
  onPick: (p: string) => void;
}) {
  const tk = useChatTokens();
  const label = useAgentLabel();
  const byName = new Map((g.agents ?? []).map((a) => [a.profile, a]));
  return (
    <Box
      component="nav"
      aria-label={t('skillsAgent.agents')}
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, py: 1 }}
    >
      {order.map((p) => {
        const setup = byName.get(p)?.setup ?? 0;
        const name = label(p) + (p === g.primary ? ` (${t('skillsAgent.primary')})` : '');
        return (
          <Tooltip key={p} title={name} placement="right">
            <Box
              component="button"
              type="button"
              data-agent={p}
              aria-label={name + (setup ? `, ${t('skillsAgent.setupHint', { n: setup })}` : '')}
              aria-current={p === agent ? 'true' : undefined}
              onClick={() => onPick(p)}
              sx={{
                all: 'unset',
                cursor: 'pointer',
                p: '4px',
                borderRadius: '10px',
                '&:hover': { bgcolor: tk.hover },
                '&[aria-current=true]': { bgcolor: tk.selected, boxShadow: `inset 0 0 0 2px ${tk.selectedAccent}` },
                '&:focus-visible': { outline: `2px solid ${FOCUS_RING}` },
              }}
            >
              <Badge
                badgeContent={setup}
                color="warning"
                overlap="circular"
                invisible={!setup}
                sx={{ '& .MuiBadge-badge': { fontSize: 10, minWidth: 16, height: 16, px: 0.5 } }}
              >
                <AgentAvatar name={p} label={label(p)} size={32} />
              </Badge>
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

/** 스킬을 고르지 않았을 때 오른쪽 칸: 그 에이전트의 「설정 필요」 스킬 목록(G15). 누르면 그 스킬의 「필요한 것」을 연다 */
function AgentOverview({ agent, rows, onPick }: { agent: string; rows: AgentSkillRow[]; onPick: (id: string) => void }) {
  const label = useAgentLabel();
  const setup = rows.filter((s) => s.readiness === 'setup');
  return (
    <Box data-testid="agent-overview">
      <Typography variant="h6" component="h2" sx={{ fontSize: 16 }}>
        {t('skillsAgent.overviewTitle', { name: label(agent) })}
      </Typography>
      <Section title={t('skillsAgent.overviewSetup')} count={setup.length}>
        {setup.length ? (
          <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
            {setup.map((s) => (
              <Box component="li" key={s.id} sx={{ py: 0.5, borderBottom: 1, borderColor: 'divider' }}>
                <Box
                  component="button"
                  type="button"
                  onClick={() => onPick(s.id)}
                  sx={{ all: 'unset', cursor: 'pointer', display: 'block', '&:hover .name': { textDecoration: 'underline' }, '&:focus-visible': { outline: `2px solid ${FOCUS_RING}` } }}
                >
                  <Stack direction="row" spacing={0.75} alignItems="center">
                    <WarningAmberIcon color="warning" sx={{ fontSize: 16 }} aria-hidden />
                    <Typography className="name" sx={{ fontWeight: 500, fontSize: 14 }}>
                      {s.name}
                    </Typography>
                  </Stack>
                  {!!s.missing_env?.length && (
                    <Typography variant="caption" color="text.secondary" component="div" sx={{ pl: 2.75, wordBreak: 'break-all' }}>
                      {t('skillsAgent.overviewMissing', { names: s.missing_env.join(', ') })}
                    </Typography>
                  )}
                </Box>
              </Box>
            ))}
          </Box>
        ) : (
          <Typography variant="body2" color="text.secondary">
            {t('skillsAgent.overviewSetupNone')}
          </Typography>
        )}
      </Section>
      <Typography color="text.secondary" variant="body2" sx={{ mt: 2 }}>
        {t('skillsAgent.pickSkill')}
      </Typography>
    </Box>
  );
}

/** 「설정 필요 N」 — 행동이 필요한 것이라 경고색 글자로 보인다(숫자만 든 아이콘 칩은 뜻을 몰랐다) */
function SetupTag({ n }: { n: number }) {
  if (!n) return null;
  return (
    <Tooltip title={t('skillsAgent.setupHint', { n })}>
      <Box
        component="span"
        data-setup={n}
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          fontSize: 11,
          fontWeight: 700,
          color: 'warning.main',
          whiteSpace: 'nowrap',
        }}
      >
        <WarningAmberIcon sx={{ fontSize: 13 }} aria-hidden />
        {t('skillsAgent.setupN', { n })}
      </Box>
    </Tooltip>
  );
}

/** 제목 옆 「용어」: 화면에 나오는 낱말 뜻을 한곳에 */
function Glossary() {
  const [el, setEl] = useState<HTMLElement | null>(null);
  const id = useId();
  return (
    <>
      <Button
        size="small"
        color="inherit"
        startIcon={<HelpOutlineIcon />}
        aria-haspopup="dialog"
        aria-controls={el ? id : undefined}
        onClick={(e) => setEl(e.currentTarget)}
      >
        {t('skillsAgent.glossary')}
      </Button>
      <Popover
        id={id}
        open={!!el}
        anchorEl={el}
        onClose={() => setEl(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'left' }}
      >
        <Box sx={{ p: 2, maxWidth: 420 }} role="dialog" aria-label={t('skillsAgent.glossaryTitle')}>
          <Typography sx={{ fontWeight: 600, mb: 1 }}>{t('skillsAgent.glossaryTitle')}</Typography>
          <Box component="ul" sx={{ m: 0, pl: 2, '& li': { mb: 0.75 } }}>
            {(['shared', 'own', 'all', 'mine', 'builtin', 'locked'] as const).map((k) => (
              <li key={k}>
                <Typography variant="body2">{t(`skillsAgent.term.${k}`)}</Typography>
              </li>
            ))}
          </Box>
        </Box>
      </Popover>
    </>
  );
}

// ---- 가운데: 그 에이전트의 스킬 ---------------------------------------------------------------------

function modeLabel(m: RunMode) {
  return t(`skillsAgent.mode.${m}`);
}

/** 정리 모드에서 고를 수 있는가 — 보관함으로 옮길 수 있고(내 스킬) 막는 이유가 없을 때만. 스킬 허브 스킬은 하나씩 지운다 */
const bulkable = (m: DeleteMode) => m.kind === 'archive' && !m.disabled;

function SkillColumn({
  agent,
  rows,
  summary,
  selected,
  filter,
  onFilter,
  onPick,
  modeOf,
}: {
  agent: string;
  rows: AgentSkillRow[];
  summary?: AgentSummary;
  selected: string;
  filter: Filter;
  onFilter: (f: Filter) => void;
  onPick: (id: string) => void;
  modeOf: (s: AgentSkillRow) => DeleteMode;
}) {
  const [q, setQ] = useState('');
  const [allShared, setAllShared] = useState(false);
  const [cleanup, setCleanup] = useState(false);
  const [chosen, setChosen] = useState<Set<string>>(new Set());
  const [bulk, setBulk] = useState(false);
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
  const label = useAgentLabel();
  const isShared = agent === 'default';
  // 정리는 이 칸의 「직접 가진」 스킬만 — 가져다 쓰는 공용 스킬의 사본은 공용 스킬에서 지운다
  const free = own.filter((s) => bulkable(modeOf(s)));
  const picked = rows.filter((s) => chosen.has(s.id) && bulkable(modeOf(s)));
  const toggle = (id: string) =>
    setChosen((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  const startCleanup = () => {
    setCleanup(true);
    setChosen(new Set());
    if (filter === 'all') onFilter('unused');
  };
  const endCleanup = () => {
    setCleanup(false);
    setChosen(new Set());
  };
  const item = { agent, selected, onPick, modeOf, cleanup, chosen, onChoose: toggle };
  return (
    <>
      <Box sx={{ px: 1.5, pt: 1.25, pb: 1, borderBottom: 1, borderColor: 'divider' }}>
        <Stack direction="row" alignItems="center" spacing={1}>
          <Typography sx={{ fontWeight: 600, flex: 1, minWidth: 0 }} noWrap>
            {isShared ? t('skillsAgent.sharedGroup') : t('skillsAgent.skillsOf', { name: label(agent) })}
          </Typography>
          {!cleanup && (
            <Tooltip describeChild title={t('skillsAgent.cleanupHint')}>
              <Button
                size="small"
                variant="outlined"
                color="inherit"
                sx={tier2}
                startIcon={<DeleteOutlineIcon />}
                onClick={startCleanup}
              >
                {t('skillsAgent.cleanup')}
              </Button>
            </Tooltip>
          )}
        </Stack>
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
          {FILTERS.map((f) => {
            const n = count(f);
            const on = filter === f;
            // 행동이 필요한 상태(설정 필요)는 0 이 아니면 경고색으로 눈에 띄게
            const tone = !on && n > 0 && f === 'setup' ? 'warning' : on ? 'primary' : 'default';
            return (
              <Chip
                key={f}
                size="small"
                label={`${t(`skillsAgent.filter.${f}`)} ${n}`}
                color={tone}
                variant={on ? 'filled' : 'outlined'}
                onClick={() => onFilter(f)}
                aria-pressed={on}
                sx={!on && n > 0 && f === 'setup' ? { fontWeight: 700 } : undefined}
              />
            );
          })}
        </Stack>
        {cleanup && (
          <Alert severity="info" icon={false} sx={{ mt: 1, py: 0.25 }} data-cleanup-bar>
            <Typography variant="body2" sx={{ fontWeight: 600 }}>
              {t('skillsAgent.cleanupTitle')}
            </Typography>
            <Stack direction="row" spacing={0.5} useFlexGap flexWrap="wrap" sx={{ mt: 0.5 }}>
              <Button
                size="small"
                color="inherit"
                disabled={!free.length}
                onClick={() => setChosen(new Set(free.map((s) => s.id)))}
              >
                {t('skillsAgent.cleanupPickFree')}
              </Button>
              <Button size="small" color="inherit" disabled={!chosen.size} onClick={() => setChosen(new Set())}>
                {t('skillsAgent.cleanupClear')}
              </Button>
            </Stack>
            {!free.length && (
              <Typography variant="caption" color="text.secondary" component="p">
                {t('skillsAgent.cleanupNone')}
              </Typography>
            )}
          </Alert>
        )}
      </Box>
      <Box sx={{ flex: 1, minHeight: 0, overflow: 'auto' }}>
        <SkillGroup
          title={isShared ? t('skillsAgent.sharedOwnTitle') : t('skillsAgent.ownSkills')}
          n={own.length}
          rows={own}
          item={item}
          empty={isShared ? t('skillsAgent.sharedOwnEmpty') : t('skillsAgent.ownEmpty')}
        />
        {!isShared && (
          <SkillGroup
            title={t('skillsAgent.sharedSkills')}
            n={sharedAll.length}
            rows={shared}
            item={{ ...item, cleanup: false }}
            empty={sharedAll.length ? t('skillsAgent.sharedNoneUsed') : t('skillsAgent.sharedEmpty')}
            more={
              !allShared && !needle && filter === 'all' && sharedAll.length > sharedUsed.length ? (
                <Button size="small" color="inherit" onClick={() => setAllShared(true)}>
                  {t('skillsAgent.sharedShowAll', { n: sharedAll.length - sharedUsed.length })}
                </Button>
              ) : undefined
            }
          />
        )}
      </Box>
      {cleanup && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          sx={{ px: 1.5, py: 1, borderTop: 1, borderColor: 'divider', bgcolor: 'background.paper' }}
        >
          <Button size="small" variant="outlined" color="inherit" sx={tier2} onClick={endCleanup}>
            {t('skillsAgent.cleanupExit')}
          </Button>
          <Box sx={{ flex: 1 }} />
          <Button
            size="small"
            variant="outlined"
            color="inherit"
            sx={tier3}
            startIcon={<DeleteOutlineIcon />}
            disabled={!picked.length}
            onClick={() => setBulk(true)}
          >
            {t('skillsAgent.cleanupGo', { n: picked.length })}
          </Button>
        </Stack>
      )}
      {bulk && (
        <BulkDeleteDialog
          skills={picked}
          onClose={(done) => {
            setBulk(false);
            if (done) endCleanup();
          }}
        />
      )}
    </>
  );
}

interface ItemCtx {
  agent: string;
  selected: string;
  onPick: (id: string) => void;
  modeOf: (s: AgentSkillRow) => DeleteMode;
  cleanup: boolean;
  chosen: Set<string>;
  onChoose: (id: string) => void;
}

function SkillGroup({
  title,
  n,
  rows,
  item,
  empty,
  more,
}: {
  title: string;
  n: number;
  rows: AgentSkillRow[];
  item: ItemCtx;
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
            <SkillItem key={s.id} s={s} ctx={item} />
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

/** 지울 수 없는 이유를 보일 자물쇠 — 부르는 곳이 있을 때만(공용 사본·기본 제공은 너무 많아 줄마다 붙이면 시끄럽다) */
function LockTag({ s }: { s: AgentSkillRow }) {
  if (s.delete_block !== 'in_use') return null;
  return (
    <Tooltip title={t('skills.del.why.in_use')}>
      <Box
        component="span"
        data-locked
        sx={{
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.25,
          fontSize: 11,
          color: 'text.secondary',
          whiteSpace: 'nowrap',
        }}
      >
        <LockOutlinedIcon sx={{ fontSize: 12 }} aria-hidden />
        {t('skillsAgent.calledBy', { n: s.dependents_n ?? 0 })}
      </Box>
    </Tooltip>
  );
}

function SkillItem({ s, ctx }: { s: AgentSkillRow; ctx: ItemCtx }) {
  const used = usedOf(s);
  const on = s.id === ctx.selected;
  const mode = ctx.modeOf(s);
  const can = bulkable(mode);
  const why = mode.kind === 'none' ? mode.why : mode.disabled;
  const unused = s.readiness === 'unused';
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
        borderColor: on ? 'primary.main' : s.readiness === 'setup' ? 'warning.main' : 'transparent',
        opacity: s.enabled === false ? 0.6 : 1,
      }}
    >
      {ctx.cleanup && (
        <Tooltip title={can ? '' : why ?? ''}>
          <Box component="span" sx={{ mt: -0.5 }}>
            <Checkbox
              size="small"
              checked={can && ctx.chosen.has(s.id)}
              disabled={!can}
              onChange={() => ctx.onChoose(s.id)}
              slotProps={{ input: { 'aria-label': t('skillsAgent.cleanupPick', { name: s.name }) } }}
            />
          </Box>
        </Tooltip>
      )}
      <Box
        component="button"
        type="button"
        onClick={() => ctx.onPick(s.id)}
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
          <Typography
            noWrap
            sx={{
              fontWeight: s.readiness === 'setup' ? 600 : 500,
              fontSize: 14,
              color: unused ? 'text.secondary' : undefined,
            }}
          >
            {s.name}
          </Typography>
          {s.readiness && s.readiness !== 'ok' && (
            <Tag tone={readinessTone(s.readiness)}>{t(`skillsAgent.ready.${s.readiness}`)}</Tag>
          )}
          <LockTag s={s} />
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
      {!ctx.cleanup && s.enabled !== undefined && <SkillSwitch agent={ctx.agent} name={s.name} on={s.enabled} />}
    </Box>
  );
}

/** 켜기/끄기 — 프로필 화면의 스킬 패널과 같은 동작(대시보드 PUT /api/skills/toggle). 끄면 그 에이전트가 이 스킬을 못 쓴다.
 *  바꾼 값은 다음 세션부터 적용된다(열린 세션은 시작할 때 읽은 스킬 목록을 쓴다). 실패하면 스위치는 원래대로 두고 이유를 알린다(G17) */
function SkillSwitch({ agent, name, on }: { agent: string; name: string; on: boolean }) {
  const { act } = useProfileAct(agent);
  const qc = useQueryClient();
  return (
    <Tooltip title={t('skillsAgent.toggleTip')}>
      <Box component="span" sx={{ display: 'inline-flex' }}>
        <Toggle
          key={String(on)}
          on={on}
          label={t('profiles.skillToggle', { name })}
          done={(next) => t(next ? 'skillsAgent.toggledOn' : 'skillsAgent.toggledOff', { name })}
          disabled={false}
          change={async (next) => {
            try {
              await act('skill', { target: name, enabled: next });
            } catch (e) {
              // Toggle 은 실패하면 스위치를 바꾸지 않는다(원래대로). 알림에 무엇이 실패했는지 붙인다
              throw new Error(t('skillsAgent.toggleFailed', { name, error: (e as Error).message }));
            }
            await Promise.all([
              qc.invalidateQueries({ queryKey: ['skills'] }),
              qc.invalidateQueries({ queryKey: ['profile', agent] }),
            ]);
          }}
          offConfirm={t('profiles.skillOffConfirm', { name })}
        />
      </Box>
    </Tooltip>
  );
}

// ---- 오른쪽: 고른 스킬 -------------------------------------------------------------------------------

function SkillPanel({
  row,
  pane,
  onPane,
  onBack,
  mode,
  onDelete,
}: {
  row: AgentSkillRow;
  pane: Pane;
  onPane: (p: Pane) => void;
  onBack?: () => void;
  mode: DeleteMode;
  onDelete: () => void;
}) {
  const one = useQuery<SkillOne>({
    queryKey: ['skill', row.id],
    queryFn: () => get<SkillOne>('/api/skill?id=' + encodeURIComponent(row.id)),
  });
  const flow = useQuery<Graph>({
    queryKey: ['flow', 'skill:' + row.id],
    queryFn: () => get<Graph>('/api/flow?root=' + encodeURIComponent('skill:' + row.id)),
  });
  const label = useAgentLabel();
  const why = mode.kind === 'none' ? mode.why : mode.disabled;
  const reasonId = useId();
  return (
    <Box data-testid="skill-panel">
      {/* 머리(이름·상태·행동·탭)는 고정 — 탭 내용만 스크롤한다. 가장 많이 쓰는 「스킬 연결도 보기」가 늘 보인다 */}
      <Box
        data-skill-head
        sx={{
          position: 'sticky',
          top: 0,
          zIndex: 2,
          bgcolor: 'background.paper',
          px: 2,
          pt: 2,
          borderBottom: 1,
          borderColor: 'divider',
        }}
      >
        {onBack && (
          <Button size="small" startIcon={<ArrowBackIcon />} onClick={onBack} sx={{ mb: 1 }}>
            {t('skillsAgent.back')}
          </Button>
        )}
        <Stack direction="row" alignItems="center" spacing={1} useFlexGap flexWrap="wrap">
          <Typography variant="h6" component="h2" sx={{ fontSize: 18 }}>
            {row.name}
          </Typography>
          {row.readiness && <Tag tone={readinessTone(row.readiness)}>{t(`skillsAgent.ready.${row.readiness}`)}</Tag>}
          {row.origin && <Tag>{t(`skills.origin.${row.origin}`)}</Tag>}
          {row.shared_from && (
            <Tag tone="info">{t('skillsAgent.sharedFrom', { name: label(row.shared_from) })}</Tag>
          )}
          {!row.shared_from && !!row.agents_n && (
            <Tag tone="info">{t('skillsAgent.usedByAgents', { n: row.agents_n })}</Tag>
          )}
        </Stack>
        {row.description && (
          <Typography
            variant="body2"
            sx={{
              mt: 0.5,
              display: '-webkit-box',
              WebkitLineClamp: 2,
              WebkitBoxOrient: 'vertical',
              overflow: 'hidden',
            }}
            title={row.description}
          >
            {row.description}
          </Typography>
        )}
        <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 0.5 }}>
          {[
            t('skillsAgent.agentIs', { name: label(row.profile) }),
            row.enabled === false ? t('skillsAgent.ready.off') : t('skillsAgent.isOn'),
            usedOf(row) ? t('skillsAgent.usedN', { n: usedOf(row) }) : t('skillsAgent.neverUsed'),
            row.last_used ? t('skillsAgent.lastUsed', { at: shortDate(row.last_used) }) : '',
          ]
            .filter(Boolean)
            .join(' · ')}
        </Typography>
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          sx={{ mt: 1 }}
          role="toolbar"
          aria-label={t('skillsAgent.actions')}
        >
          <Button
            component={RouterLink}
            to={'/flows?root=' + encodeURIComponent('skill:' + row.id)}
            size="small"
            variant="outlined"
            color="inherit"
            sx={tier1}
            startIcon={<AccountTreeOutlinedIcon />}
          >
            {t('skills.viewFlow')}
          </Button>
          <Box sx={{ flex: 1 }} />
          {why ? (
            <Tooltip title={why}>
              <Box
                component="span"
                sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: 'text.secondary', fontSize: 12 }}
                data-delete-why
              >
                <LockOutlinedIcon sx={{ fontSize: 14 }} aria-hidden />
                <span id={reasonId}>{why}</span>
              </Box>
            </Tooltip>
          ) : null}
          {mode.kind !== 'none' && (
            <Button
              size="small"
              variant="outlined"
              color="inherit"
              sx={tier3}
              startIcon={<DeleteOutlineIcon />}
              disabled={!!mode.disabled}
              aria-describedby={mode.disabled ? reasonId : undefined}
              onClick={onDelete}
            >
              {t('skillsAgent.delete')}
            </Button>
          )}
        </Stack>
        {/* 넘치면 가로로 밀어 본다 — 폰에서 「게시」 탭에 닿지 못했다. 고른 탭은 아래 선만, 바탕을 깔지 않는다(DESIGN.md Tabs, G13) */}
        <Tabs
          value={pane}
          onChange={(_e, v: Pane) => onPane(v)}
          variant="scrollable"
          scrollButtons="auto"
          allowScrollButtonsMobile
          sx={{ mt: 1, minHeight: 40, '& .MuiTab-root.Mui-selected': { bgcolor: 'transparent' } }}
        >
          {PANES.map((p) => (
            <Tab key={p} value={p} label={t(`skillsAgent.pane.${p}`)} sx={{ minHeight: 40 }} />
          ))}
        </Tabs>
      </Box>
      <Box sx={{ p: 2 }}>
        {pane === 'overview' && <OverviewPane row={row} one={one.data} onFiles={() => onPane('files')} />}
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
/** 이 스킬을 부르는 쪽(위쪽, depth < 0)은 「시작·부르는 곳」에 — 「부르는 도구」에는 이 스킬이 부르는 것만 */
const inLane = (lane: string, n: FNode) =>
  lane === 'start'
    ? n.kind === 'cron' || n.depth < 0
    : n.depth >= 0 && (LANES.find((l) => l.id === lane)?.kinds.includes(n.kind) ?? false);

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
          const items = nodes.filter((n) => inLane(lane.id, n));
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
                  <NodeCard key={n.id} node={n} label={n.label} sub={n.sub || kindLabel(n.kind)} edges={edgeTo(n.id)} profile={row.profile} />
                ))}
              </Stack>
            </Box>
          );
        })}
      </Box>
      <Typography variant="caption" color="text.secondary" component="p" sx={{ mt: 2 }}>
        {t('skillsAgent.runNote')}
      </Typography>
    </Box>
  );
}

/** API 키·토큰 화면에서 이 에이전트의 값을 고치러 가는 링크. 대화 화면 메뉴의 링크와 같은 주소다(G18) */
export function CredsFixLink({ profile }: { profile: string }) {
  return (
    <LinkChip to="credentials" params={{ tab: 'all', profile }}>
      {t('skillsAgent.fixInCreds')}
    </LinkChip>
  );
}

/** 근거 배지의 색. 「등록됨」(자산 목록에 등록됨)은 정상이라 중립색, 호박색은 주의 상태에만(G19). 노드가 나쁨이면 빨강 */
export const nodeBadgeTone = (badge: string, bad: boolean): 'bad' | 'warn' | undefined => {
  const tone = badgeTone(badge);
  if (tone === 'good') return undefined;
  return bad ? 'bad' : tone;
};

function NodeCard({ node, label, sub, edges, profile }: { node?: FNode; label: string; sub: string; edges: FEdge[]; profile?: string }) {
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
  // 만료됨·비어 있음 같은 자격증명 카드에는 고칠 곳으로 가는 링크(G18)
  const fixCred = node?.kind === 'cred' && (node.status === 'bad' || node.status === 'warn');
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
          <Tag key={b} tone={nodeBadgeTone(b, bad)}>
            {serverTerm(b)}
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
      {(node?.link || (fixCred && profile)) && (
        <Box sx={{ mt: 0.5 }}>
          {node?.link && (
            <LinkChip to={node.link.view} params={node.link.params}>
              {t('skillsAgent.open')}
            </LinkChip>
          )}
          {fixCred && profile && <CredsFixLink profile={profile} />}
        </Box>
      )}
    </Box>
  );
}

type Need = { key: string; kind: string; name: string; state: 'ok' | 'warn' | 'bad'; note: string; action?: ReactNode };

/** 「필요한 것」: 선언한 환경변수(그 에이전트 .env 기준) ∪ 코드가 쓰는 자격증명·MCP 서버·라이브러리. 값은 보이지 않는다 */
function NeedsPane({ row, one, flow }: { row: AgentSkillRow; one?: SkillOne; flow?: Graph }) {
  const label = useAgentLabel();
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
      // 값이 없는 줄(설정 필요)에는 값을 넣는 곳과 API 키·토큰 화면 링크(G18)
      action: e.set ? undefined : (
        <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
          <LinkChip to="profiles" params={{ name: row.profile, pane: 'env', key: e.name }} page>
            {t('skills.envFill')}
          </LinkChip>
          <CredsFixLink profile={row.profile} />
        </Box>
      ),
    });
  });
  (flow?.nodes ?? [])
    .filter((n) => n.kind === 'cred' || n.kind === 'mcp' || n.kind === 'lib')
    .forEach((n) => {
      if (n.kind === 'cred' && declared.has(n.label)) return;
      const fixCred = n.kind === 'cred' && (n.status === 'bad' || n.status === 'warn');
      needs.push({
        key: n.id,
        kind: kindLabel(n.kind),
        name: n.label,
        state: n.status === 'bad' ? 'bad' : n.status === 'warn' ? 'warn' : 'ok',
        note: [n.sub, ...(n.badges ?? []).map(serverTerm)].filter(Boolean).join(' · '),
        action:
          n.link || fixCred ? (
            <Box sx={{ display: 'flex', flexWrap: 'wrap', justifyContent: 'flex-end' }}>
              {n.link && (
                <LinkChip to={n.link.view} params={n.link.params}>
                  {t('skillsAgent.open')}
                </LinkChip>
              )}
              {/* 만료됨 등 자격증명 줄: 고칠 곳(G18). 판정·문구는 서버(API 키·토큰 화면의 만료 날짜) 그대로 */}
              {fixCred && <CredsFixLink profile={row.profile} />}
            </Box>
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
        {t('skillsAgent.needsNote', { name: label(row.profile) })}
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

/** 고른 스킬의 SKILL.md(같은 폴더 파일 목록 포함). 개요와 파일 탭이 같은 질의 키를 써 요청이 하나다(스펙 2026-11-06-003 §8-6) */
function useSkillFile(one?: SkillOne) {
  const path = one ? `${one.path}/SKILL.md` : '';
  return useQuery<FileData>({
    queryKey: ['file', path, 'siblings'],
    queryFn: () => get<FileData>(`/api/file?siblings=1&path=${encodeURIComponent(path)}`),
    enabled: !!path,
  });
}

/** SKILL.md 머리말(맨 앞 --- 블록)을 떼고 빈 줄을 뺀 앞 n 줄(OV-L1) */
function skillExcerpt(lines: string[], n = EXCERPT_LINES): string[] {
  let body = lines;
  if (lines[0]?.trim() === '---') {
    const end = lines.findIndex((l, i) => i > 0 && l.trim() === '---');
    body = end > 0 ? lines.slice(end + 1) : [];
  }
  return body.filter((l) => l.trim()).slice(0, n);
}

/**
 * 「개요」(기본 탭, R1): AI 요약 → (요약이 없을 때) SKILL.md 앞부분 → 설정 필요 줄 → 「AI 에게 더 묻기」.
 * 요약은 같은 스킬의 개요를 1.5초 볼 때만 만든다(D3). 스킬을 바꾸면 SkillPanel 이 새로 생기고 탭을 바꾸면 이 칸이 닫혀 타이머가 지워진다.
 * 요약이 꺼짐·읽기 오류(요약 경로가 없는 옛 서버)·아직 없음(기다리는 동안·만드는 동안)·만들기 실패면 SKILL.md 앞부분을 보이고, 요약이 생기면 숨긴다(D5·D8)
 */
function OverviewPane({ row, one, onFiles }: { row: AgentSkillRow; one?: SkillOne; onFiles: () => void }) {
  const target = { id: row.id };
  const sv = useSummaryView(target);
  const f = useSkillFile(one);
  const summaryOn = !!sv.data?.enabled;
  const showExcerpt = !!sv.error || (!!sv.data && (!sv.data.enabled || !sv.data.summary));
  const excerpt = f.data ? skillExcerpt(f.data.lines) : [];
  const missing = row.missing_env ?? [];
  return (
    <Box data-testid="skill-overview">
      {summaryOn && (
        <Section title={t('market.summary.title')}>
          <AiSummary target={target} autoDelay={SUMMARY_DWELL_MS} />
        </Section>
      )}
      {showExcerpt && (
        <Section title={t('skillsAgent.excerpt')}>
          <Box data-testid="skill-excerpt">
            {f.data ? (
              excerpt.length > 0 && (
                // 원문은 신뢰할 수 없어 마크다운으로 렌더하지 않고 글자 그대로 보인다(AiSummary 와 같은 규칙)
                <Typography component="div" variant="body2" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {excerpt.join('\n')}
                </Typography>
              )
            ) : f.error ? (
              <Alert severity="warning">{f.error.message}</Alert>
            ) : (
              <LinearProgress aria-label={t('skillsAgent.loading')} />
            )}
            <Button size="small" onClick={onFiles} sx={{ mt: 0.5, px: 0 }}>
              {t('skillsAgent.excerptMore')}
            </Button>
          </Box>
        </Section>
      )}
      {missing.length > 0 && (
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          useFlexGap
          flexWrap="wrap"
          data-testid="skill-setup"
          sx={{ mt: 2 }}
        >
          <WarningAmberIcon color="warning" fontSize="small" aria-hidden />
          <Typography variant="body2" sx={{ wordBreak: 'break-all' }}>
            {`${t('skillsAgent.setupNeeded')} — ${t('skillsAgent.overviewMissing', { names: missing.join(', ') })}`}
          </Typography>
          <CredsFixLink profile={row.profile} />
        </Stack>
      )}
      {/* 「AI 에게 더 묻기」는 파일 탭에서 옮겼다. 「고치기 요청」은 파일 탭에 남는다(OV-L2) */}
      {one && (
        <Box sx={{ mt: 2 }}>
          <ChatChip agent={row.profile} text={t('skills.explainPrompt', { name: one.name, path: one.path })}>
            {t('skills.explainAction')}
          </ChatChip>
        </Box>
      )}
    </Box>
  );
}

/** 「파일」: SKILL.md 와 같은 폴더의 파일, 내려받기, AI 에이전트에게 고치기 부탁. AI 요약·「AI 에게 더 묻기」는 개요 탭으로 옮겼다(R1) */
function FilesPane({ row, one }: { row: AgentSkillRow; one?: SkillOne }) {
  const f = useSkillFile(one);
  const [filesOpen, setFilesOpen] = useState(false);
  const filesId = useId();
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
        <ChatChip agent={talkTo} text={t('skills.editPrompt', { name: one.name, path: one.path })}>
          {t('skills.editAction')}
        </ChatChip>
      </Stack>
      {!one.shared_from && one.origin !== 'aas' && <DownloadSkill s={one} />}
      {!!f.data?.siblings?.length && (
        <Section
          title={t('skillsAgent.folderFiles')}
          count={f.data.siblings.length}
          action={
            // 처음에는 접어 둔다 — 파일이 수십 개면 목록이 SKILL.md 를 화면 밖으로 밀어냈다(2026-11-06 사용자 지시)
            <DisclosureButton
              open={filesOpen}
              onToggle={() => setFilesOpen((v) => !v)}
              label={filesOpen ? t('skillsAgent.folderFilesHide') : t('skillsAgent.folderFilesShow')}
              controls={filesId}
              sx={{ ml: 1 }}
            />
          }
        >
          {filesOpen && (
            // 한 줄에 하나, 스킬 폴더 안 경로로 보인다 — 빈칸으로 이어 붙여 긴 경로가 한 덩어리로 보였다(2026-11-06 사용자 지시)
            <Box component="ul" id={filesId} data-testid="folder-files" sx={{ m: 0, p: 0, listStyle: 'none', fontFamily: monoFont, fontSize: 12 }}>
              {f.data.siblings.map((p) => (
                <Box component="li" key={p} title={p} sx={{ py: 0.25, overflowWrap: 'anywhere' }}>
                  {one && p.startsWith(one.path + '/') ? p.slice(one.path.length + 1) : p}
                </Box>
              ))}
            </Box>
          )}
        </Section>
      )}
      <Section title="SKILL.md">
        {f.data ? (
          // 스킬 연결도 「코드」 탭과 같은 편집기(Monaco)를 읽기 전용으로 쓴다 — 줄 번호·색칠·찾기(2026-11-06 사용자 지시)
          <Suspense fallback={<LinearProgress aria-label={t('skillsAgent.loading')} />}>
            <LazyCodeEditor
              readOnly
              value={f.data.lines.join('\n')}
              onChange={() => undefined}
              language={languageOf('SKILL.md', true)}
              ariaLabel={t('flows.codeOf', { name: 'SKILL.md' })}
              minRows={3}
              tabIndents={false}
            />
          </Suspense>
        ) : f.error ? (
          <Alert severity="warning">{f.error.message}</Alert>
        ) : (
          <LinearProgress aria-label={t('skillsAgent.loading')} />
        )}
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

/** 게시 단계(1 점검 · 2 확인 · 3 요청). 지금 단계에 aria-current="step" (G14) */
function PublishSteps({ step }: { step: 1 | 2 | 3 }) {
  return (
    <Box
      component="ol"
      aria-label={t('skillsAgent.steps')}
      sx={{ listStyle: 'none', m: 0, mb: 1, p: 0, display: 'flex', flexWrap: 'wrap', gap: 1, fontSize: 13 }}
    >
      {([1, 2, 3] as const).map((n) => (
        <Box
          component="li"
          key={n}
          aria-current={n === step ? 'step' : undefined}
          sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: n === step ? 'text.primary' : 'text.secondary', fontWeight: n === step ? 600 : 400 }}
        >
          {n > 1 && (
            <Box component="span" aria-hidden sx={{ color: 'text.secondary', fontWeight: 400 }}>
              ·
            </Box>
          )}
          {`${n} ${t(`skillsAgent.step.${n}`)}`}
        </Box>
      ))}
    </Box>
  );
}

/** 「게시」: 점검 → 확인 → 게시 요청. 점검은 아무것도 저장하지 않는다(POST /api/market/publish/check). 승인 규칙은 그대로.
 *  게시 단추는 점검 결과 아래에 두고, 막히면 이유(실패 n건)를 단추 옆에 적는다. 경고만 있으면 게시할 수 있다(G14) */
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
  /** 게시를 요청했다 — 결과를 지우지 않고 요청 상태를 남긴다(G14) */
  const [sent, setSent] = useState('');
  // 공용에서 가져온 스킬은 원래 프로파일의 폴더를 올린다. 사용 기록은 이 에이전트 줄(id)로 본다
  const owner = row.shared_from ?? row.profile;
  const label = useAgentLabel();
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
      setSent('');
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
      const msg =
        req?.auto === 'pending'
          ? t('skills.publishAuto', {
              name: name.trim(),
              ns: req.auto_namespace_label ?? req.auto_namespace ?? '',
              vis: req.auto_public ? t('skills.visPublic') : t('skills.visMembers'),
            })
          : t('skills.publishRequested', { name: name.trim() });
      enqueueSnackbar(msg, { variant: 'success' });
      setSent(msg);
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
  const fails = res ? res.checks.filter((c) => c.level === 'fail').length : 0;
  const step: 1 | 2 | 3 = sent ? 3 : res ? 2 : 1;
  const declare = res?.env.undeclared ?? [];
  return (
    <Box>
      <PublishSteps step={step} />
      <Typography variant="body2" color="text.secondary" sx={{ mb: 1 }}>
        {t('skillsAgent.publishIntro')}
      </Typography>
      {row.shared_from && (
        <Alert severity="info" sx={{ mb: 1 }}>
          {t('skillsAgent.publishShared', { name: label(owner) })}
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
      </Stack>
      {busy && <LinearProgress aria-label={t('skillsAgent.checking')} sx={{ mb: 1 }} />}
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
            {/* 파일마다 한 줄(한 줄로 뭉쳐 읽기 어려웠다, G14) */}
            <Box component="ul" data-testid="publish-files" sx={{ listStyle: 'none', m: 0, p: 0, fontFamily: monoFont, fontSize: 12 }}>
              {res.files.map((f) => (
                <Box component="li" key={f.path} sx={{ wordBreak: 'break-all' }}>
                  {`${f.path} (${Math.max(1, Math.round(f.size / 1024))}KiB)`}
                </Box>
              ))}
            </Box>
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
          {/* 3 요청: 결과 아래. 바뀌는 머리말을 단추 바로 위에, 막힌 이유를 단추 옆에 */}
          <Box data-testid="publish-request" sx={{ mt: 2, pt: 1.5, borderTop: 1, borderColor: 'divider' }}>
            {declare.length > 0 && (
              <Typography variant="body2" sx={{ mb: 1 }} data-testid="publish-header-change">
                {t('skillsAgent.headerChange', { names: declare.join(', ') })}
              </Typography>
            )}
            {stale && (
              <Typography variant="caption" color="warning.main" component="p" sx={{ mb: 1 }}>
                {t('skillsAgent.recheckHint')}
              </Typography>
            )}
            <Stack direction="row" spacing={1} alignItems="center" useFlexGap flexWrap="wrap">
              <Button
                variant="contained"
                disableElevation
                disabled={busy || fails > 0 || !!stale || !!sent}
                onClick={() => void send()}
              >
                {t('skills.publishAsk')}
              </Button>
              {fails > 0 && (
                <Typography variant="body2" color="error.main" data-testid="publish-blocked">
                  {t('skillsAgent.publishBlocked', { n: fails })}
                </Typography>
              )}
            </Stack>
            {sent && (
              <Alert severity="success" sx={{ mt: 1 }} data-testid="publish-sent">
                {sent}
              </Alert>
            )}
          </Box>
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

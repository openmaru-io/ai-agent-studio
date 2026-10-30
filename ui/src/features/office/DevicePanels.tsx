/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 장면의 장치를 누르면 여는 서랍(계획 007 P5): 서버 단말 → 에이전트 파드 상태(관리자만), 칸반 보드 → 보드 요약.
// 디자인: 위에 한 줄 요약과 비율 막대, 아래에 구분선만 있는 줄 목록. 상태는 뱃지로 보인다.
import DnsOutlinedIcon from '@mui/icons-material/DnsOutlined';
import ViewKanbanOutlinedIcon from '@mui/icons-material/ViewKanbanOutlined';
import { Alert, Box, Stack, Typography, useTheme } from '@mui/material';
import { useQuery } from '@tanstack/react-query';

import { AgentChip } from '@/components/AgentChip';
import { LinkChip } from '@/components/bits';
import { OwnerChip } from '@/components/OwnerChip';
import { PanelEmpty } from '@/components/PanelEmpty';
import { PillTone, StatusPill } from '@/components/StatusPill';
import { useOfficeCards } from '@/features/office/cards';
import { agentName } from '@/features/office/model';
import { t } from '@/i18n';
import { get } from '@/lib/api';
import { toastTokens } from '@/lib/shellTokens';
import type { Seat } from '@/screens/office/forms';

interface AgentRow {
  name: string;
  /** 에이전트 이름(HermesAgent displayName). 비어 있으면 설치본 id(name)를 보인다 */
  display_name?: string;
  owner: string;
  phase: string;
  message?: string;
  ready: boolean;
}

type Accent = { readonly [K in keyof (typeof toastTokens)['dark']['accent']]: string };

/** 요약 한 줄과 그 아래 비율 막대. parts 는 [값, 색 고르는 함수] 이고 막대는 값의 비율로 나눈다. */
function Summary({ label, parts }: { label: string; parts: [number, (a: Accent) => string][] }) {
  const th = useTheme();
  const accent = toastTokens[th.palette.mode].accent;
  const total = parts.reduce((n, [v]) => n + v, 0) || 1;
  return (
    <Box sx={{ mb: 2 }}>
      <Typography variant="body2" sx={{ fontWeight: 600, fontVariantNumeric: 'tabular-nums' }}>
        {label}
      </Typography>
      <Box aria-hidden sx={{ display: 'flex', gap: '2px', height: 4, mt: 1, borderRadius: 2, overflow: 'hidden' }}>
        {parts
          .filter(([v]) => v > 0)
          .map(([v, color], i) => (
            <Box key={i} sx={{ flex: `${v / total} 1 0`, bgcolor: color(accent) }} />
          ))}
      </Box>
    </Box>
  );
}

const rowSx = { display: 'flex', alignItems: 'center', gap: 1.5, py: 1, borderBottom: '1px solid', borderColor: 'divider', '&:last-of-type': { borderBottom: 0 } } as const;

export function ServerPanel() {
  const q = useQuery<{ admin: boolean; enabled: boolean; agents: AgentRow[] }>({
    queryKey: ['agents-list'],
    queryFn: () => get('/api/agents'),
    retry: false,
  });
  if (q.isLoading) return <Typography color="text.secondary">{t('office.sceneLoading')}</Typography>;
  if (q.error) return <Alert severity="error">{(q.error as Error).message}</Alert>;
  if (!q.data?.admin) return <Alert severity="info">{t('office.serverAdminOnly')}</Alert>;
  if (!q.data.enabled) return <Alert severity="info">{t('office.serverNotK8s')}</Alert>;
  const agents = q.data.agents;
  if (!agents.length)
    return (
      <PanelEmpty
        icon={DnsOutlinedIcon}
        title={t('office.serverEmpty')}
        action={<LinkChip to="agents">{t('office.openAgents')}</LinkChip>}
      />
    );
  const ready = agents.filter((a) => a.ready).length;
  const failed = agents.filter((a) => !a.ready && a.phase === 'Failed').length;
  const tone = (a: AgentRow): PillTone => (a.ready ? 'good' : a.phase === 'Failed' ? 'bad' : 'warn');
  return (
    <Box>
      <Summary
        label={t('office.serverSummary', { ready, total: agents.length })}
        parts={[
          [ready, (c) => c.success],
          [failed, (c) => c.error],
          [agents.length - ready - failed, (c) => c.default],
        ]}
      />
      <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {agents.map((a) => (
          <Box component="li" key={a.name} sx={rowSx}>
            <Box sx={{ flex: 1, minWidth: 0 }}>
              {/* 설치본 id 대신 에이전트 이름. 점 색은 id 기준, id 는 풍선말(스펙 2026-10-20-029) */}
              <AgentChip name={a.display_name || a.name} colorKey={a.name} title={a.display_name ? a.name : undefined} size="sm" />
              {a.owner && (
                <Typography variant="caption" color="text.secondary" component="div" noWrap>
                  <OwnerChip email={a.owner} />
                </Typography>
              )}
            </Box>
            <StatusPill tone={tone(a)}>{a.ready ? t('dashboard.ready') : a.phase}</StatusPill>
          </Box>
        ))}
      </Stack>
      <Box sx={{ mt: 2 }}>
        <LinkChip to="agents">{t('office.openAgents')}</LinkChip>
      </Box>
    </Box>
  );
}

const ORDER = ['running', 'review', 'blocked', 'ready', 'todo', 'scheduled', 'triage'];
const SHOWN = 12;

const statusLabel = (s: string) => {
  const k = `office.col${s[0].toUpperCase()}${s.slice(1)}`;
  const v = t(k);
  return v === k ? s : v;
};

// 카드는 서랍 안에서 직접 읽는다 — 서랍을 연 뒤에 카드가 바뀌어도(20초마다 다시 읽는다) 보드 요약이 따라간다
export function BoardPanel() {
  const cards = useOfficeCards();
  // 담당(자리 별칭) → 3D 이름표와 같은 이름. 오피스 화면이 읽은 자리 목록을 같은 키로 나눠 쓴다(스펙 2026-10-20-029)
  const seats = useQuery<{ seats: Seat[] }>({ queryKey: ['office'], queryFn: () => get('/api/office') }).data?.seats;
  const nameOf = (alias: string) => {
    const s = seats?.find((x) => x.alias === alias);
    return s ? agentName(s) : alias;
  };
  const open = cards.filter((c) => c.status !== 'done');
  if (!open.length)
    return (
      <PanelEmpty
        icon={ViewKanbanOutlinedIcon}
        title={t('office.boardEmpty')}
        action={
          <LinkChip to="office" params={{ tab: 'kanban' }}>
            {t('office.inboxOpenKanban')}
          </LinkChip>
        }
      />
    );
  const groups = ORDER.filter((s) => open.some((c) => c.status === s));
  return (
    <Box>
      <Summary
        label={t('office.boardSummary', { n: open.length })}
        parts={groups.map((s): [number, (a: Accent) => string] => [
          open.filter((c) => c.status === s).length,
          (a) => (s === 'running' ? a.info : s === 'review' ? a.warning : s === 'blocked' ? a.error : a.default),
        ])}
      />
      <Stack spacing={2.5}>
        {groups.map((s) => {
          const list = open.filter((c) => c.status === s);
          return (
            <Box key={s} component="section">
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, mb: 0.5 }}>
                <Typography variant="subtitle2" component="h3">
                  {statusLabel(s)}
                </Typography>
                <StatusPill tone={s === 'blocked' ? 'bad' : s === 'review' ? 'warn' : s === 'running' ? 'info' : 'neutral'}>{list.length}</StatusPill>
              </Box>
              <Stack component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                {list.slice(0, SHOWN).map((c) => (
                  <Box component="li" key={`${c.board}/${c.task_id}`} sx={rowSx}>
                    <Typography variant="body2" sx={{ flex: 1, minWidth: 0 }} noWrap>
                      {c.title}
                    </Typography>
                    {c.assignee ? (
                      <AgentChip name={nameOf(c.assignee)} colorKey={c.assignee} title={nameOf(c.assignee) !== c.assignee ? c.assignee : undefined} size="sm" />
                    ) : (
                      <Typography variant="caption" color="text.secondary">
                        —
                      </Typography>
                    )}
                  </Box>
                ))}
              </Stack>
              {list.length > SHOWN && (
                <Typography variant="caption" color="text.secondary">
                  {t('office.boardMore', { n: list.length - SHOWN })}
                </Typography>
              )}
            </Box>
          );
        })}
      </Stack>
      <Box sx={{ mt: 2.5 }}>
        <LinkChip to="office" params={{ tab: 'kanban' }}>
          {t('office.inboxOpenKanban')}
        </LinkChip>
      </Box>
    </Box>
  );
}

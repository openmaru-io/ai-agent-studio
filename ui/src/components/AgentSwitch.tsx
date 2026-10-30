/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 상단 막대의 에이전트 고르개(스펙 2026-10-19-019). 지금 에이전트를 보이고, 누르면 볼 수 있는 에이전트 목록에서 바꾼다.
// 목록 줄(agentMenuItems)은 계정 메뉴도 함께 쓴다. 부품이 아니라 MenuItem 배열을 돌려준다 — MUI MenuList 는 바로 아래
// 자식에서 selected 줄을 찾아 열 때 포커스를 주므로, 부품으로 감싸면 포커스가 갈 곳이 없다(O1).
// 바꾸는 중 상태(pendingId)는 AppShell 이 가진다: 계정 메뉴에서 골라도 이 단추가 같은 표시를 한다(DD4).
import CheckIcon from '@mui/icons-material/Check';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import SmartToyOutlinedIcon from '@mui/icons-material/SmartToyOutlined';
import { Box, CircularProgress, ListSubheader, Menu, MenuItem, SxProps, Theme, Tooltip, Typography, useTheme } from '@mui/material';
import { ReactNode, useState } from 'react';

import { t } from '@/i18n';
import { viewerAgentLabel, viewerAgentParts } from '@/lib/agentLabel';
import { chatMetrics, chatTokens } from '@/lib/chatTokens';
import type { Me } from '@/lib/data';
import { dialogTokens, shellColors, shellMetrics, toastTokens } from '@/lib/shellTokens';

import { menuItemSx } from './menuItemSx';
import { SubtleBadge } from './SubtleBadge';

type Pod = Me['pods'][number];

const DIM = 'rgba(255,255,255,0.6)';
/** 주인·에이전트 글자의 최대 폭(R2), 그 안에서 에이전트 이름이 지키는 폭(DD1) */
const LABEL_MAX = 220;
const AGENT_KEEP = 160;

/** 내 것(이름순) → 남의 것(주인 이름순, 그다음 에이전트 이름순)(DD3) */
export function sortPods(pods: Pod[], viewerEmail?: string): Pod[] {
  const me = (viewerEmail ?? '').toLowerCase();
  const mine = (p: Pod) => !!me && (p.owner ?? '').toLowerCase() === me;
  const name = (p: Pod) => p.name || p.id;
  return [...pods].sort(
    (a, b) =>
      Number(mine(b)) - Number(mine(a)) ||
      (mine(a) ? 0 : (a.owner_name || a.owner || '').localeCompare(b.owner_name || b.owner || '', 'ko')) ||
      name(a).localeCompare(name(b), 'ko')
  );
}

type SectionKey = 'mine' | 'team' | 'shared';
const SECTION_LABEL: Record<SectionKey, string> = { mine: 'shell.agentsMine', team: 'shell.agentsTeam', shared: 'shell.agentsShared' };

/** 「내 에이전트 / 내 팀 / 공유받은」 구역(스펙 2026-10-22-001 DD2). 내 팀은 팀 관리자로 다루는 팀원 것(team), 공유받은은 내 것도 팀 것도 아닌 것.
 *  구역 안 순서는 sortPods 그대로이고 빈 구역은 뺀다 */
export function podSections(pods: Pod[], viewerEmail?: string): { key: SectionKey; pods: Pod[] }[] {
  const me = (viewerEmail ?? '').toLowerCase();
  const keyOf = (p: Pod): SectionKey => (me && (p.owner ?? '').toLowerCase() === me ? 'mine' : p.team ? 'team' : 'shared');
  const sorted = sortPods(pods, viewerEmail);
  return (['mine', 'team', 'shared'] as const).map((key) => ({ key, pods: sorted.filter((p) => keyOf(p) === key) })).filter((x) => x.pods.length);
}

const subheaderSx = (muted: string) => ({ px: 2.25, pt: 0.25, pb: 0.5, fontSize: 12, lineHeight: 1.5, color: muted, bgcolor: 'transparent', position: 'static' }) as const;

/** 에이전트 메뉴 줄. 지금 줄을 누르면 메뉴만 닫는다(R9) — 두 메뉴 공통.
 *  sections 를 주면 구역이 둘 이상일 때 구역 머리글(초점이 가지 않는 ListSubheader, DD11)을 줄 사이에 넣는다 — 그 글자 색이 sections.muted */
export function agentMenuItems({
  pods,
  currentId,
  viewerEmail,
  sx,
  onClose,
  onPick,
  sections,
}: {
  pods: Pod[];
  currentId?: string;
  viewerEmail?: string;
  sx: SxProps<Theme>;
  onClose: () => void;
  onPick: (id: string) => void;
  sections?: { muted: string };
}): ReactNode[] {
  const groups = podSections(pods, viewerEmail);
  const heads = !!sections && groups.length > 1;
  return groups.flatMap((g) => [
    ...(heads ? [<ListSubheader key={`head-${g.key}`} sx={subheaderSx(sections.muted)}>{t(SECTION_LABEL[g.key])}</ListSubheader>] : []),
    ...g.pods.map(menuRow),
  ]);

  function menuRow(p: Pod) {
    const on = currentId === p.id;
    const label = viewerAgentLabel(p, viewerEmail); // 남의 것은 「주인 이름 · 에이전트 이름」, id 는 풍선말(스펙 2026-10-19-003)
    return (
      <MenuItem
        key={p.id}
        role="menuitemradio"
        aria-checked={on}
        aria-label={t(p.team ? 'shell.agentOptionTeam' : 'shell.agentOption', { id: label })}
        selected={on}
        sx={sx}
        onClick={() => {
          onClose();
          if (!on) onPick(p.id);
        }}
      >
        <Typography noWrap title={p.id} sx={{ flex: 1, minWidth: 0, fontSize: 13, fontWeight: on ? 600 : 400, color: 'inherit' }}>
          {label}
        </Typography>
        {/* 팀원 에이전트는 「팀」 배지(DD5). 뜻은 글자로 말한다(DD11) */}
        {p.team && <SubtleBadge>{t('shell.teamBadge')}</SubtleBadge>}
        {on && <CheckIcon aria-hidden="true" sx={{ fontSize: 16 }} />}
      </MenuItem>
    );
  }
}

/** 여러 줄 풍선말(DD13). 첫 줄은 단추 이름, 나머지는 흐린 보조 글자이고 warn 줄만 호박색 */
export function TipLines({ lines }: { lines: { text: string; warn?: boolean }[] }) {
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', gap: '2px' }}>
      {lines.map((l, i) => (
        <Box
          key={i}
          component="span"
          sx={{ fontSize: i === 0 ? 12 : 11.5, color: l.warn ? toastTokens.dark.accent.warning : i === 0 ? shellColors.menuActiveText : DIM }}
        >
          {l.text}
        </Box>
      ))}
    </Box>
  );
}

/** team: 팀원 에이전트면 이름 뒤에 「팀」 배지(DD5). 상단 막대는 늘 어두워 다크 토큰으로 그린다 */
function Label({ owner, agent, team }: { owner: string; agent: string; team?: boolean }) {
  return (
    <>
      <Box component="span" sx={{ display: 'flex', alignItems: 'baseline', minWidth: 0, maxWidth: LABEL_MAX, overflow: 'hidden', whiteSpace: 'nowrap' }}>
        {owner && (
          <Box component="span" sx={{ color: DIM, flexShrink: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis' }}>
            {owner}&nbsp;·&nbsp;
          </Box>
        )}
        <Box component="span" sx={{ flexShrink: 0, maxWidth: owner ? AGENT_KEEP : LABEL_MAX, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {agent}
        </Box>
      </Box>
      {team && <SubtleBadge mode="dark">{t('shell.teamBadge')}</SubtleBadge>}
    </>
  );
}

const iconSx = { fontSize: 16, color: DIM, flexShrink: 0 } as const;

export interface AgentSwitchProps {
  pods: Pod[];
  pod: Me['pod'];
  viewerEmail?: string;
  /** 서버가 에이전트 등록부를 읽지 못했을 때의 오류(me.registry_error) */
  registryError?: string;
  /** 바꾸는 중인 에이전트 id(AppShell 이 가진다, DD4) */
  pendingId?: string | null;
  onPick: (id: string) => void;
}

export function AgentSwitch({ pods, pod, viewerEmail, registryError, pendingId, onPick }: AgentSwitchProps) {
  const mode = useTheme().palette.mode;
  const tk = chatTokens[mode];
  const dlg = dialogTokens[mode];
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);

  if (!pod && pods.length === 0) return null; // 에이전트가 없는 설치(로컬 모드)

  // 누를 것이 없으면 단추가 아니라 흐린 글자(D2·DD6·DD12): 지금 것만 있거나, 목록을 못 읽었을 때
  if (pod && pods.length <= 1) {
    const parts = viewerAgentParts(pod, viewerEmail);
    const tip = pods.length === 0 && registryError ? [{ text: pod.id }, { text: t('topbar.agentListFailed'), warn: true }] : [{ text: pod.id }];
    return (
      <Tooltip title={<TipLines lines={tip} />}>
        <Box
          component="span"
          data-testid="agent-current"
          sx={{ display: 'inline-flex', alignItems: 'center', gap: '6px', height: 32, px: 1, color: DIM, fontSize: shellMetrics.topbarFontSize, flexShrink: 0, minWidth: 0 }}
        >
          <SmartToyOutlinedIcon sx={iconSx} />
          <Label {...parts} team={pod.team} />
        </Box>
      </Tooltip>
    );
  }

  const pending = pendingId ? pods.find((p) => p.id === pendingId) : undefined;
  const shown = pending ?? pod ?? undefined;
  const parts = shown ? viewerAgentParts(shown, viewerEmail) : { owner: '', agent: t('topbar.agentChoose') };
  const full = shown ? viewerAgentLabel(shown, viewerEmail) : t('topbar.agentChoose');
  const busy = !!pendingId;
  const open = !!anchor;
  const grouped = podSections(pods, viewerEmail).length > 1;
  const tipLines = shown ? [{ text: t('topbar.agentSwitch') }, { text: full }, { text: shown.id }] : [{ text: t('topbar.agentSwitch') }];
  return (
    <>
      <Tooltip title={<TipLines lines={tipLines} />} describeChild>
        <Box
          component="button"
          type="button"
          aria-label={shown ? t(shown.team ? 'topbar.agentAriaTeam' : 'topbar.agentAria', { name: full }) : full}
          aria-haspopup="menu"
          aria-expanded={open}
          aria-busy={busy || undefined}
          disabled={busy}
          onClick={(e) => setAnchor(e.currentTarget)}
          sx={{
            display: 'inline-flex',
            alignItems: 'center',
            gap: '6px',
            height: 32,
            pl: 1,
            pr: 0.5,
            flexShrink: 0,
            minWidth: 0,
            font: 'inherit',
            fontSize: shellMetrics.topbarFontSize,
            color: open ? shellColors.menuActiveText : shellColors.menuText,
            bgcolor: open ? 'rgba(255,255,255,0.06)' : 'transparent',
            border: 0,
            borderRadius: '6px',
            cursor: busy ? 'default' : 'pointer',
            '&:hover:not(:disabled)': { bgcolor: open ? 'rgba(255,255,255,0.06)' : 'rgba(255,255,255,0.04)', color: shellColors.menuActiveText },
            '&:focus-visible': { outline: `2px solid ${shellColors.menuActiveText}`, outlineOffset: 1 }, // 막대는 늘 어두워 테마 링(밝은 모드 #111827)은 안 보인다(DD11)
            '@media (pointer: coarse)': { height: chatMetrics.touch },
          }}
        >
          <SmartToyOutlinedIcon sx={iconSx} />
          <Label {...parts} team={shown?.team} />
          {busy ? (
            <CircularProgress
              size={14}
              thickness={5}
              aria-hidden="true"
              sx={{ color: DIM, mx: '2px', '@media (prefers-reduced-motion: reduce)': { '& .MuiCircularProgress-svg': { animation: 'none' }, animation: 'none' } }}
            />
          ) : (
            <ExpandMoreIcon
              aria-hidden="true"
              sx={{ fontSize: 18, transition: 'transform 160ms', transform: open ? 'rotate(180deg)' : 'none', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}
            />
          )}
        </Box>
      </Tooltip>
      <Menu
        anchorEl={anchor}
        open={open}
        onClose={() => setAnchor(null)}
        anchorOrigin={{ vertical: 'bottom', horizontal: 'right' }}
        transformOrigin={{ vertical: 'top', horizontal: 'right' }}
        slotProps={{
          paper: {
            sx: {
              mt: 0.75,
              width: 296,
              maxWidth: 'calc(100vw - 16px)',
              maxHeight: 'calc(100vh - 96px)',
              borderRadius: '12px',
              bgcolor: dlg.surface,
              backgroundImage: 'none',
              border: '1px solid',
              borderColor: tk.popup.edge,
              boxShadow: `${tk.popup.shadow}, ${tk.popup.highlight}`,
            },
          },
          list: { sx: { py: 0.75 } },
        }}
      >
        {/* 구역이 둘 이상이면 구역 머리글이 「에이전트」 머리글을 대신한다(DD2) */}
        {grouped ? null : <ListSubheader sx={subheaderSx(tk.muted)}>{t('shell.agents')}</ListSubheader>}
        {agentMenuItems({
          pods,
          currentId: pod?.id,
          viewerEmail,
          sx: menuItemSx(tk),
          onClose: () => setAnchor(null),
          onPick,
          sections: { muted: tk.muted },
        })}
      </Menu>
    </>
  );
}

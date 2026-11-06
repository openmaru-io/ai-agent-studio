/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 3칸 틀(AI 에이전트 | 세션 | 대화)의 부품: 칸 폭·접힘 기억, 칸 사이 끌개, 접힌 AI 에이전트 띠.
// 폭과 접힘은 이 브라우저에만 남는다(localStorage). 저장을 못 하면 기본값으로 그린다.
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ForumOutlinedIcon from '@mui/icons-material/ForumOutlined';
import SearchIcon from '@mui/icons-material/Search';
import { Badge, Box, IconButton, Tooltip } from '@mui/material';
import { KeyboardEvent, PointerEvent as ReactPointerEvent, useCallback, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { AgentInfo, ChatGroup, ChatStore, rowTitle } from '@/lib/chatStore';
import { FOCUS_RING } from '@/lib/shellTokens';

import { AgentAvatar } from './parts';

export interface ChatLayout {
  agentsW: number;
  sessionsW: number;
  agentsCollapsed: boolean;
  sessionsCollapsed: boolean;
}
export const LAYOUT_KEY = 'aas-chat-layout';
export const LAYOUT_DEFAULT: ChatLayout = { agentsW: 280, sessionsW: 300, agentsCollapsed: false, sessionsCollapsed: false };
export const LIMITS = { agents: [220, 400] as const, sessions: [240, 480] as const };
/** 접힌 AI 에이전트 띠·접힌 세션 띠의 폭 */
export const STRIP_W = 56;
export const SESSION_STRIP_W = 44;

const clamp = (v: number, [lo, hi]: readonly [number, number]) => Math.min(hi, Math.max(lo, Math.round(v)));

export function readLayout(): ChatLayout {
  try {
    const v = JSON.parse(localStorage.getItem(LAYOUT_KEY) || '{}') as Partial<ChatLayout>;
    return {
      agentsW: clamp(Number(v.agentsW) || LAYOUT_DEFAULT.agentsW, LIMITS.agents),
      sessionsW: clamp(Number(v.sessionsW) || LAYOUT_DEFAULT.sessionsW, LIMITS.sessions),
      agentsCollapsed: v.agentsCollapsed === true,
      sessionsCollapsed: v.sessionsCollapsed === true,
    };
  } catch {
    return { ...LAYOUT_DEFAULT };
  }
}

/** 칸 폭·접힘. patch 는 범위 안으로 맞춰 저장한다 */
export function useChatLayout(): [ChatLayout, (patch: Partial<ChatLayout>) => void] {
  const [layout, setLayout] = useState<ChatLayout>(readLayout);
  const update = useCallback((patch: Partial<ChatLayout>) => {
    setLayout((prev) => {
      const next = { ...prev, ...patch };
      next.agentsW = clamp(next.agentsW, LIMITS.agents);
      next.sessionsW = clamp(next.sessionsW, LIMITS.sessions);
      try {
        localStorage.setItem(LAYOUT_KEY, JSON.stringify(next));
      } catch {
        /* 이번 화면에서만 */
      }
      return next;
    });
  }, []);
  return [layout, update];
}

/** 칸 사이 끌개. 끌거나 ←/→(16px)·Home·End 로 폭을 바꾸고, 두 번 누르거나 Enter 로 왼쪽 칸을 접는다 */
export function Splitter({
  label,
  value,
  limits,
  onChange,
  onToggle,
}: {
  label: string;
  value: number;
  limits: readonly [number, number];
  onChange: (v: number) => void;
  onToggle?: () => void;
}) {
  const tk = useChatTokens();
  const drag = useRef<{ x: number; v: number } | null>(null);
  const [active, setActive] = useState(false);
  const onPointerDown = (e: ReactPointerEvent<HTMLDivElement>) => {
    if (e.button !== 0) return;
    e.preventDefault();
    drag.current = { x: e.clientX, v: value };
    setActive(true);
    const move = (ev: PointerEvent) => {
      if (drag.current) onChange(clamp(drag.current.v + ev.clientX - drag.current.x, limits));
    };
    const up = () => {
      drag.current = null;
      setActive(false);
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      document.body.style.removeProperty('cursor');
      document.body.style.removeProperty('user-select');
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
    document.body.style.cursor = 'col-resize';
    document.body.style.userSelect = 'none';
  };
  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    const step = e.shiftKey ? 48 : 16;
    if (e.key === 'ArrowLeft') onChange(clamp(value - step, limits));
    else if (e.key === 'ArrowRight') onChange(clamp(value + step, limits));
    else if (e.key === 'Home') onChange(limits[0]);
    else if (e.key === 'End') onChange(limits[1]);
    else if (e.key === 'Enter' && onToggle) onToggle();
    else return;
    e.preventDefault();
  };
  return (
    <Box
      role="separator"
      aria-orientation="vertical"
      aria-label={label}
      aria-valuenow={value}
      aria-valuemin={limits[0]}
      aria-valuemax={limits[1]}
      tabIndex={0}
      data-active={active || undefined}
      onPointerDown={onPointerDown}
      onKeyDown={onKeyDown}
      onDoubleClick={onToggle}
      sx={{
        position: 'relative',
        width: 6,
        mx: '-3px',
        zIndex: 2,
        cursor: 'col-resize',
        touchAction: 'none',
        '&::after': { content: '""', position: 'absolute', top: 0, bottom: 0, left: 2, width: 2, bgcolor: 'transparent', transition: 'background-color .12s' },
        '&:hover::after, &[data-active]::after': { bgcolor: tk.selectedAccent },
        '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
      }}
    />
  );
}

/** 접힌 AI 에이전트 칸: 아바타 띠. 아바타를 누르면 그 AI 에이전트로 새 세션, 배지는 살아 있는 세션 수(답 필요가 먼저) */
export function AgentStrip({
  store,
  onPick,
  onExpand,
  onSearch,
  canExpand,
}: {
  store: ChatStore;
  onPick: (name: string, pod?: string) => void;
  onExpand: () => void;
  onSearch: () => void;
  canExpand: boolean;
}) {
  const tk = useChatTokens();
  const counts = store.countsByAgent();
  const multi = store.groups.length > 1;
  const items: { a: AgentInfo; g: ChatGroup | undefined; pod?: string }[] = multi
    ? store.groups.flatMap((g) => g.agents.map((a) => ({ a, g, pod: g.pod })))
    : (store.status?.agents ?? []).map((a) => ({ a, g: (store.group() ?? store.status ?? undefined) as ChatGroup | undefined, pod: undefined }));
  return (
    <Box
      component="aside"
      aria-label={t('chat.agentsLabel')}
      data-guide="chat.agents"
      sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 0.5, py: 1, flex: 1, bgcolor: tk.rail, overflowY: 'auto', overflowX: 'hidden', minHeight: 0 }}
    >
      {canExpand && (
        <Tooltip title={t('chat.agentsExpand')} placement="right">
          <IconButton size="small" aria-label={t('chat.agentsExpand')} onClick={onExpand} sx={{ color: tk.muted }}>
            <ChevronRightIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      )}
      <Tooltip title={t('chat.allAgentsRow')} placement="right">
        <IconButton
          size="small"
          aria-label={t('chat.allAgentsRow')}
          aria-current={!store.agentFilter}
          onClick={() => store.setAgentFilter(null)}
          sx={{ color: tk.muted, '&[aria-current=true]': { bgcolor: tk.selected, color: tk.text } }}
        >
          <ForumOutlinedIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      <Tooltip title={t('chat.allAgentsPick')} placement="right">
        <IconButton size="small" aria-label={t('chat.allAgentsPick')} onClick={onSearch} sx={{ color: tk.muted, mb: 0.5 }}>
          <SearchIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {items.map(({ a, g, pod }) => {
        const name = rowTitle(g, a);
        const label = multi && g?.name && name !== g.name ? `${g.name} / ${name}` : name;
        const c = counts[`${pod ?? store.status?.pod ?? ''}|${a.name}`] ?? counts[`${pod ?? ''}|${a.name}`];
        const n = c ? c.waiting || c.running : 0;
        return (
          <Tooltip key={`${pod ?? ''}|${a.name}`} title={label} placement="right">
            <Box
              component="button"
              type="button"
              aria-label={t('chat.agentPick', { name: label })}
              aria-current={!!store.agentFilter && store.agentFilter.profile === a.name && (store.agentFilter.pod ?? '') === (pod ?? store.status?.pod ?? '')}
              onClick={() => onPick(a.name, pod)}
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
                badgeContent={n}
                color={c?.waiting ? 'warning' : 'info'}
                overlap="circular"
                invisible={!n}
                sx={{ '& .MuiBadge-badge': { fontSize: 10, minWidth: 16, height: 16, px: 0.5 } }}
              >
                <AgentAvatar name={g?.name || pod || a.name} label={name} size={32} tone="hue" dot={a.running === false ? 'off' : undefined} />
              </Badge>
            </Box>
          </Tooltip>
        );
      })}
    </Box>
  );
}

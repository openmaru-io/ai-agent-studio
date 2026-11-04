/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 세션 목록: 채팅의 왼쪽 칸. 에이전트보다 「어느 세션이 지금 어떤 상태인가」가 먼저 보이게 한다.
// 묶음 순서는 내 답 필요 → 실행 중 → 최근. 줄마다 상태 표시·세션 제목·그 세션이 도는 에이전트를 보인다.
import AddIcon from '@mui/icons-material/Add';
import CloseIcon from '@mui/icons-material/Close';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import { Box, Button, CircularProgress, IconButton, TextField, Tooltip, Typography, useTheme } from '@mui/material';
import { useEffect, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { ChatGroup, ChatStore, groupLabel, rowTitle, SessionRow, SessionState } from '@/lib/chatStore';
import { chatType } from '@/lib/chatTokens';
import { fmtClock, zonedDate } from '@/lib/format';
import { FOCUS_RING, gridTokens } from '@/lib/shellTokens';

import { AgentAvatar } from './parts';

const whenOf = (ts: number) => {
  if (!ts) return '';
  const d = zonedDate(ts);
  const n = zonedDate(Date.now());
  return d.y === n.y && d.m === n.m && d.d === n.d ? fmtClock(ts) : `${d.m}/${d.d}`;
};

const STATE_LABEL: Record<SessionState, string> = {
  waiting: 'chat.sessWaiting',
  running: 'chat.sessRunning',
  done: 'chat.sessDone',
  idle: 'chat.sessIdle',
  closed: 'chat.sessClosed',
};

/** 세션이 도는 에이전트의 보일 이름과 색 기준. 프로파일이 하나뿐이면 에이전트 이름만(rowTitle 규칙) */
export function agentLabelOf(store: ChatStore, pod: string | undefined, profile: string): { label: string; colorKey: string } {
  const g: ChatGroup | undefined = store.groups.find((x) => x.pod === pod) ?? (pod ? undefined : (store.status as ChatGroup | null) ?? undefined);
  const a = g?.agents.find((x) => x.name === profile) ?? { name: profile };
  const name = rowTitle(g, a);
  const multi = store.groups.length > 1 && g && name !== groupLabel(g);
  return { label: multi ? `${groupLabel(g)} / ${name}` : name, colorKey: g?.name || g?.pod || profile };
}

/** 상태 표시: 실행 중은 돌아가는 고리, 답 필요는 주황 물음표, 끝났고 안 봄은 채운 점 */
export function StateMark({ state }: { state: SessionState }) {
  const theme = useTheme();
  const tk = useChatTokens();
  const box = { width: 16, height: 16, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } as const;
  if (state === 'running') return <Box sx={box}><CircularProgress size={12} thickness={5} sx={{ color: tk.muted }} aria-hidden /></Box>;
  if (state === 'waiting') return <Box sx={box}><HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 16, color: theme.palette.warning.main }} /></Box>;
  if (state === 'done') return <Box sx={box}><Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', bgcolor: theme.palette.success.main }} /></Box>;
  if (state === 'closed') return <Box sx={box}><Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${tk.muted}` }} /></Box>;
  return <Box sx={box}><Box aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: tk.line }} /></Box>;
}

function Row({ store, r, onPick }: { store: ChatStore; r: SessionRow | null; onPick: (r: SessionRow) => void }) {
  const tk = useChatTokens();
  const draft = r === null; // 아직 보내지 않은 새 세션(지금 화면)
  const pod = draft ? store.status?.pod : r.pod;
  const profile = draft ? store.profile : r.profile;
  const { label, colorKey } = agentLabelOf(store, pod, profile);
  const title = draft ? t('chat.sessDraft') : r.title || t('chat.sessUntitled');
  const state: SessionState = draft ? 'idle' : r.state;
  const selected = draft ? !store.currentId : store.currentId === r.id;
  return (
    <Box
      sx={{
        position: 'relative',
        '&:hover .sess-close, &:focus-within .sess-close': { opacity: 1 },
      }}
    >
      <Box
        component="button"
        type="button"
        data-session-row={draft ? 'draft' : r.id}
        data-state={state}
        aria-current={selected}
        aria-label={t('chat.sessAria', { title, agent: label, state: t(STATE_LABEL[state]) })}
        onClick={() => (draft ? undefined : onPick(r))}
        sx={{
          all: 'unset',
          boxSizing: 'border-box',
          display: 'flex',
          gap: 1,
          width: '100%',
          px: 1.5,
          py: 1,
          pr: 4,
          cursor: 'pointer',
          alignItems: 'flex-start',
          color: tk.text,
          borderRadius: '8px',
          '&:hover': { bgcolor: tk.hover },
          '&[aria-current=true]': { bgcolor: tk.selected, boxShadow: `inset 2px 0 0 ${tk.selectedAccent}` },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
        }}
      >
        <Box sx={{ pt: '2px' }}>
          <StateMark state={state} />
        </Box>
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
            <Box
              component="span"
              title={title}
              sx={{
                flex: 1,
                minWidth: 0,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
                fontSize: chatType.name,
                fontWeight: !draft && (r.unread || state === 'waiting') ? 700 : 500,
                fontStyle: draft ? 'italic' : undefined,
              }}
            >
              {title}
            </Box>
            {!draft && (
              <Typography component="span" sx={{ color: tk.muted, fontSize: chatType.meta, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {whenOf(r.at)}
              </Typography>
            )}
          </Box>
          {/* 이 세션이 도는 에이전트(아바타·이름)와 상태 글. 세션이 어느 에이전트의 것인지 늘 보이게 */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5, minWidth: 0 }}>
            <AgentAvatar name={colorKey} label={label} size={18} tone="hue" />
            <Typography component="span" noWrap sx={{ color: tk.muted, fontSize: 12, minWidth: 0 }} title={label}>
              {label}
            </Typography>
            {state === 'waiting' || state === 'running' ? (
              <Typography component="span" noWrap sx={{ fontSize: 11, color: tk.muted, flexShrink: 0 }}>
                {'· ' + t(STATE_LABEL[state])}
              </Typography>
            ) : null}
          </Box>
        </Box>
      </Box>
      {!draft && (
        <Tooltip title={t('chat.sessClose')}>
          <IconButton
            className="sess-close"
            size="small"
            aria-label={t('chat.sessClose')}
            onClick={() => store.dismiss(r.id)}
            sx={{ position: 'absolute', right: 4, top: 8, opacity: 0, color: tk.muted, '@media (pointer: coarse)': { opacity: 1 } }}
          >
            <CloseIcon sx={{ fontSize: 14 }} />
          </IconButton>
        </Tooltip>
      )}
    </Box>
  );
}

/** 세션 목록. onPick 은 세션을 열고 주소를 맞춘다, onNew 는 에이전트 고르기로 옮긴다 */
export function SessionList({ store, onPick, onNew }: { store: ChatStore; onPick: (r: SessionRow) => void; onNew: () => void }) {
  const tk = useChatTokens();
  const gt = gridTokens[useTheme().palette.mode];
  const [q, setQ] = useState('');
  const needle = q.trim().toLowerCase();

  // 다른 탭·새로 고침 전에 연 내 세션을 서버에서 읽는다. 창을 다시 볼 때와 20초마다 맞춘다
  useEffect(() => {
    void store.loadSessions();
    const timer = window.setInterval(() => void store.loadSessions(), 20000);
    const onFocus = () => void store.loadSessions();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [store]);

  const rows = store
    .sessionRows()
    .filter((r) => !needle || `${r.title} ${agentLabelOf(store, r.pod, r.profile).label} ${r.profile}`.toLowerCase().includes(needle));
  const groups: { key: string; label: string; rows: SessionRow[] }[] = [
    { key: 'waiting', label: t('chat.sessGroupWaiting'), rows: rows.filter((r) => r.state === 'waiting') },
    { key: 'running', label: t('chat.sessGroupRunning'), rows: rows.filter((r) => r.state === 'running') },
    { key: 'recent', label: t('chat.sessGroupRecent'), rows: rows.filter((r) => r.state !== 'waiting' && r.state !== 'running') },
  ].filter((g) => g.rows.length);
  const draft = !!store.profile && !store.currentId;

  return (
    <Box component="nav" aria-label={t('chat.sessionsLabel')} data-guide="chat.sessions">
      <Box sx={{ p: 1.5, display: 'flex', flexDirection: 'column', gap: 1 }}>
        <Tooltip title={t('chat.newSessionTip')}>
          <Button
            fullWidth
            variant="outlined"
            color="inherit"
            startIcon={<AddIcon />}
            onClick={onNew}
            data-guide="chat.newSession"
            sx={{ justifyContent: 'flex-start', borderRadius: '10px', textTransform: 'none', fontWeight: 600, borderColor: tk.line }}
          >
            {t('chat.newSession')}
          </Button>
        </Tooltip>
        <TextField
          size="small"
          fullWidth
          type="search"
          placeholder={t('chat.findSessionPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('chat.findSessionLabel') } }}
          sx={{
            '& .MuiOutlinedInput-root': { bgcolor: gt.searchBg, fontSize: chatType.name, '& fieldset': { borderColor: gt.searchLine } },
            '& .MuiOutlinedInput-root.Mui-focused fieldset, & .MuiOutlinedInput-root:hover fieldset': { borderColor: gt.searchFocus },
          }}
        />
      </Box>
      <Box sx={{ px: 0.75, pb: 2 }}>
        {draft && !needle && <Row store={store} r={null} onPick={onPick} />}
        {groups.map((g) => (
          <Box key={g.key} component="section" aria-label={g.label} sx={{ mt: 1 }}>
            <Typography component="h3" sx={{ px: 1.5, py: 0.5, fontSize: chatType.meta, fontWeight: 600, color: tk.muted }}>
              {g.label}
              {g.key !== 'recent' ? ` ${g.rows.length}` : ''}
            </Typography>
            {g.rows.map((r) => (
              <Row key={r.id} store={store} r={r} onPick={onPick} />
            ))}
          </Box>
        ))}
        {!rows.length && !(draft && !needle) && (
          <Typography color="text.secondary" sx={{ p: 2, fontSize: 13 }}>
            {needle ? t('chat.sessNoMatch') : t('chat.sessNone')}
          </Typography>
        )}
      </Box>
    </Box>
  );
}

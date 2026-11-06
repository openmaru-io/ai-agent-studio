/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 세션 목록: 채팅 3칸의 가운데 칸. 에이전트 칸에서 AI 에이전트를 고르면 그 에이전트 전용이 된다(2026-11-06).
// 묶음은 둘뿐이다 — 진행 중(답 필요 → 실행 중 → 열린 세션)과 완료(기본 어제까지, 「1주일」로 넓힌다). 고정은 맨 위.
// 완료에는 이 서버가 연 세션뿐 아니라 Hermes 에 저장된 지난 세션도 든다 — 누르면 그 대화를 이어서 연다.
import AddIcon from '@mui/icons-material/Add';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import CloseIcon from '@mui/icons-material/Close';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import HelpOutlineRoundedIcon from '@mui/icons-material/HelpOutlineRounded';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import PushPinIcon from '@mui/icons-material/PushPin';
import PushPinOutlinedIcon from '@mui/icons-material/PushPinOutlined';
import {
  Badge,
  Box,
  Button,
  Checkbox,
  Chip,
  CircularProgress,
  IconButton,
  Menu,
  MenuItem,
  TextField,
  Tooltip,
  Typography,
  useTheme,
} from '@mui/material';
import { MouseEvent, useEffect, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { useConfirm } from '@/components/ConfirmDialog';
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
const dayIndex = (ts: number) => {
  const d = zonedDate(ts);
  return Math.floor(Date.UTC(d.y, d.m - 1, d.d) / 86400000);
};

const STATE_LABEL: Record<SessionState, string> = {
  waiting: 'chat.sessWaiting',
  running: 'chat.sessRunning',
  done: 'chat.sessDone',
  idle: 'chat.sessIdle',
  closed: 'chat.sessClosed',
};
/** 저장 세션의 출처 표시(AAS 가 아닌 것만 보인다) */
const SOURCE_LABEL: Record<string, string> = { telegram: 'chat.srcTelegram', buzz: 'chat.srcBuzz' };
/** 완료 묶음의 기간. 2d = 오늘·어제, 7d = 오늘 포함 7일 */
type Range = '2d' | '7d';
const RANGE_KEY = 'aas-chat-done-range';
function readRange(): Range {
  try {
    return localStorage.getItem(RANGE_KEY) === '7d' ? '7d' : '2d';
  } catch {
    return '2d';
  }
}
const live = (s: SessionState) => s === 'waiting' || s === 'running';
const DONE_PAGE = 30;

const GROUPS_KEY = 'aas-chat-sess-collapsed';
function readFolded(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(GROUPS_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

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
  const box = { width: 18, height: 18, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', flexShrink: 0 } as const;
  if (state === 'running') return <Box sx={box}><CircularProgress size={13} thickness={5} sx={{ color: theme.palette.info.main }} aria-hidden /></Box>;
  if (state === 'waiting') return <Box sx={box}><HelpOutlineRoundedIcon aria-hidden sx={{ fontSize: 18, color: theme.palette.warning.main }} /></Box>;
  if (state === 'done') return <Box sx={box}><Box aria-hidden sx={{ width: 9, height: 9, borderRadius: '50%', bgcolor: theme.palette.success.main }} /></Box>;
  if (state === 'closed') return <Box sx={box}><Box aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', border: `1.5px solid ${tk.muted}` }} /></Box>;
  return <Box sx={box}><Box aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: tk.line }} /></Box>;
}

function Row({
  store,
  r,
  onPick,
  onClose,
  select,
  oneAgent,
}: {
  store: ChatStore;
  r: SessionRow | null;
  onPick: (r: SessionRow) => void;
  onClose: (ids: string[]) => void;
  /** 선택 모드: 체크칸이 보이고 줄을 누르면 고르기만 한다 */
  select?: { on: boolean; checked: boolean; toggle: (id: string, range: boolean) => void };
  /** 한 AI 에이전트의 세션만 보는 중 — 줄마다 에이전트 이름을 되풀이하지 않는다 */
  oneAgent?: boolean;
}) {
  const tk = useChatTokens();
  const theme = useTheme();
  const draft = r === null; // 아직 보내지 않은 새 세션(지금 화면)
  const pod = draft ? store.status?.pod : r.pod;
  const profile = draft ? store.profile : r.profile;
  const { label, colorKey } = agentLabelOf(store, pod, profile);
  const title = draft ? t('chat.sessDraft') : r.title || t('chat.sessUntitled');
  const state: SessionState = draft ? 'idle' : r.state;
  const selected = draft ? !store.currentId : store.currentId === r.id;
  const selecting = !draft && !!select?.on;
  const click = (e: MouseEvent) => {
    if (draft) return;
    if (selecting) select!.toggle(r.id, e.shiftKey);
    else onPick(r);
  };
  return (
    <Box
      sx={{
        position: 'relative',
        '&:hover .sess-act, &:focus-within .sess-act': { opacity: 1 },
      }}
    >
      <Box
        component="button"
        type="button"
        data-session-row={draft ? 'draft' : r.id}
        data-state={state}
        aria-current={selected}
        aria-pressed={selecting ? select!.checked : undefined}
        aria-label={
          selecting
            ? t('chat.sessSelectRow', { title })
            : !draft && r.stored
              ? t('chat.sessResumeAria', { title })
              : t('chat.sessAria', { title, agent: label, state: t(STATE_LABEL[state]) })
        }
        onClick={click}
        sx={{
          all: 'unset',
          boxSizing: 'border-box',
          display: 'flex',
          gap: 1,
          width: '100%',
          px: 1.25,
          py: 1,
          pr: selecting || (!draft && r.stored) ? 1.25 : 7,
          cursor: 'pointer',
          alignItems: 'flex-start',
          color: tk.text,
          borderRadius: '8px',
          '&:hover': { bgcolor: tk.hover },
          '&[aria-current=true]': { bgcolor: tk.selected, boxShadow: `inset 2px 0 0 ${tk.selectedAccent}` },
          '&[aria-pressed=true]': { bgcolor: tk.selected },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
          // 답 필요는 줄 바탕을 옅게 칠해 멀리서도 보이게
          ...(state === 'waiting' && !selected ? { bgcolor: `${theme.palette.warning.main}14` } : {}),
        }}
      >
        {selecting ? (
          <Checkbox size="small" checked={select!.checked} tabIndex={-1} disableRipple sx={{ p: 0, mt: '1px' }} inputProps={{ 'aria-hidden': true }} />
        ) : (
          <Box sx={{ pt: '1px' }}>
            <StateMark state={state} />
          </Box>
        )}
        <Box sx={{ flex: 1, minWidth: 0 }}>
          <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.75 }}>
            {!draft && r.pinned ? <PushPinIcon aria-hidden sx={{ fontSize: 12, color: tk.muted, alignSelf: 'center' }} /> : null}
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
          {/* 모든 AI 에이전트를 볼 때는 세션이 어느 에이전트의 것인지(아바타·이름), 한 에이전트를 볼 때는 출처·메시지 수 */}
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5, minWidth: 0 }}>
            {!oneAgent && <AgentAvatar name={colorKey} label={label} size={18} tone="hue" />}
            {!oneAgent && (
              <Typography component="span" noWrap sx={{ color: tk.muted, fontSize: 12, minWidth: 0 }} title={label}>
                {label}
              </Typography>
            )}
            {!draft && r.stored && r.source && r.source !== 'aas' ? (
              <Box component="span" sx={{ fontSize: 11, px: 0.75, borderRadius: 999, border: `1px solid ${tk.line}`, color: tk.muted, flexShrink: 0 }}>
                {SOURCE_LABEL[r.source] ? t(SOURCE_LABEL[r.source]) : r.source === 'cli' ? 'CLI' : r.source}
              </Box>
            ) : null}
            {!draft && r.stored && r.count ? (
              <Typography component="span" noWrap sx={{ color: tk.muted, fontSize: 12, flexShrink: 0 }}>
                {t('chat.sessPastMeta', { n: r.count })}
              </Typography>
            ) : null}
            {oneAgent && !draft && !r.stored && !live(state) ? (
              <Typography component="span" noWrap sx={{ color: tk.muted, fontSize: 12 }}>
                {t(STATE_LABEL[state])}
              </Typography>
            ) : null}
            {live(state) ? (
              <Typography
                component="span"
                noWrap
                sx={{ fontSize: 11, flexShrink: 0, fontWeight: 600, color: state === 'waiting' ? theme.palette.warning.main : theme.palette.info.main }}
              >
                {'· ' + t(STATE_LABEL[state])}
              </Typography>
            ) : null}
          </Box>
        </Box>
      </Box>
      {!draft && !selecting && !r.stored && (
        <Box
          className="sess-act"
          sx={{ position: 'absolute', right: 4, top: 6, display: 'flex', opacity: 0, '@media (pointer: coarse)': { opacity: 1 } }}
        >
          <Tooltip title={r.pinned ? t('chat.sessUnpin') : t('chat.sessPin')}>
            <IconButton size="small" aria-label={r.pinned ? t('chat.sessUnpin') : t('chat.sessPin')} onClick={() => store.togglePin(r.id)} sx={{ color: tk.muted }}>
              {r.pinned ? <PushPinIcon sx={{ fontSize: 14 }} /> : <PushPinOutlinedIcon sx={{ fontSize: 14 }} />}
            </IconButton>
          </Tooltip>
          <Tooltip title={t('chat.sessClose')}>
            <IconButton size="small" aria-label={t('chat.sessClose')} onClick={() => onClose([r.id])} sx={{ color: tk.muted }}>
              <CloseIcon sx={{ fontSize: 14 }} />
            </IconButton>
          </Tooltip>
        </Box>
      )}
    </Box>
  );
}

/** 접힌 세션 칸: 펼치기 단추와 답 필요·실행 중 수 */
export function SessionStrip({ store, onExpand }: { store: ChatStore; onExpand: () => void }) {
  const tk = useChatTokens();
  const rows = store.sessionRows();
  const waiting = rows.filter((r) => r.state === 'waiting').length;
  const running = rows.filter((r) => r.state === 'running').length;
  return (
    <Box component="nav" aria-label={t('chat.sessionsLabel')} sx={{ display: 'flex', flexDirection: 'column', alignItems: 'center', gap: 1.5, py: 1, bgcolor: tk.rail, height: '100%' }}>
      <Tooltip title={t('chat.sessionsExpand')} placement="right">
        <IconButton size="small" aria-label={t('chat.sessionsExpand')} onClick={onExpand} sx={{ color: tk.muted }}>
          <ChevronRightIcon fontSize="small" />
        </IconButton>
      </Tooltip>
      {waiting ? (
        <Tooltip title={`${t('chat.sessGroupWaiting')} ${waiting}`} placement="right">
          <Badge badgeContent={waiting} color="warning">
            <StateMark state="waiting" />
          </Badge>
        </Tooltip>
      ) : null}
      {running ? (
        <Tooltip title={`${t('chat.sessGroupRunning')} ${running}`} placement="right">
          <Badge badgeContent={running} color="info">
            <StateMark state="running" />
          </Badge>
        </Tooltip>
      ) : null}
    </Box>
  );
}

/** 세션 목록. onPick 은 세션을 열고(저장 세션이면 이어서) 주소를 맞춘다, onNew 는 새 세션(한 AI 에이전트를 보는 중이면 그 에이전트로),
 *  onCollapse 가 있으면 접기 단추를 둔다 */
export function SessionList({
  store,
  onPick,
  onNew,
  onCollapse,
  onCurrentClosed,
}: {
  store: ChatStore;
  onPick: (r: SessionRow) => void;
  onNew: () => void;
  onCollapse?: () => void;
  /** 지금 보던 세션을 닫았다 — 주소의 session 을 지운다(새로 고침 때 닫은 세션이 다시 열리지 않게) */
  onCurrentClosed?: () => void;
}) {
  const tk = useChatTokens();
  const gt = gridTokens[useTheme().palette.mode];
  const confirm = useConfirm();
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [folded, setFolded] = useState<string[]>(readFolded);
  const [range, setRangeState] = useState<Range>(readRange);
  const [doneShown, setDoneShown] = useState(DONE_PAGE);
  const [selecting, setSelecting] = useState(false);
  const [picked, setPicked] = useState<Set<string>>(new Set());
  const anchor = useRef('');
  const needle = q.trim().toLowerCase();
  const f = store.agentFilter;
  const fKey = f ? `${f.pod ?? ''}|${f.profile}` : '';

  // 다른 탭·새로 고침 전에 연 내 세션을 서버에서 읽는다. 창을 다시 볼 때와 20초마다 맞춘다.
  // 한 AI 에이전트를 보는 중이면 그 에이전트의 지난 세션(Hermes 저장분)도 같이 읽는다(60초 안이면 다시 묻지 않는다)
  useEffect(() => {
    const tick = () => {
      void store.loadSessions();
      const cur = store.agentFilter;
      if (cur) void store.loadPast(cur.pod, cur.profile);
    };
    tick();
    const timer = window.setInterval(tick, 20000);
    window.addEventListener('focus', tick);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', tick);
    };
  }, [store, fKey]);
  // 다른 AI 에이전트로 옮기면 「더 보기」를 처음으로
  useEffect(() => setDoneShown(DONE_PAGE), [fKey, range]);

  const setRange = (r: Range) => {
    setRangeState(r);
    try {
      localStorage.setItem(RANGE_KEY, r);
    } catch {
      /* 이번 화면에서만 */
    }
  };

  const all = f ? store.agentRows(f.pod, f.profile) : store.sessionRows();
  const rows = all.filter((r) => !needle || `${r.title} ${agentLabelOf(store, r.pod, r.profile).label} ${r.profile}`.toLowerCase().includes(needle));
  const today = dayIndex(Date.now());
  const ageOf = (r: SessionRow) => (r.at ? today - dayIndex(r.at) : 0);
  const inRange = (r: SessionRow) => ageOf(r) < (range === '7d' ? 7 : 2);
  const pinned = rows.filter((r) => r.pinned);
  // 진행 중: 답 필요 → 실행 중 → 아직 열려 있는(이 서버가 받고 있는) 세션 중 오늘 활동한 것. 끝난 세션은 완료로
  const liveRows = rows.filter((r) => !r.pinned && live(r.state));
  const openToday = rows.filter((r) => !r.pinned && !live(r.state) && !r.stored && r.state !== 'closed' && (r.id === store.currentId || r.state === 'done'));
  const progress = [...liveRows.filter((r) => r.state === 'waiting'), ...liveRows.filter((r) => r.state === 'running'), ...openToday];
  const progressIds = new Set(progress.map((r) => r.id));
  const doneAll = rows.filter((r) => !r.pinned && !progressIds.has(r.id)).sort((a, b) => b.at - a.at);
  // 찾는 중에는 기간을 따지지 않는다 — 찾는 세션이 1주일 밖에 있으면 안 보였다
  const done = needle ? doneAll : doneAll.filter(inRange);
  const beyond = needle || range === '7d' ? 0 : doneAll.filter((r) => ageOf(r) < 7).length - done.length;
  const draft = !!store.profile && !store.currentId && (!f || (f.profile === store.profile && (f.pod ?? '') === (store.status?.pod ?? '')));
  const finished = all.filter((r) => !live(r.state) && !r.pinned && !r.stored && r.id !== store.currentId);
  const loadingPast = !!f && store.pastLoading(f.pod, f.profile);
  const groups: { key: string; label: string; rows: SessionRow[]; count?: boolean; range?: boolean }[] = [
    { key: 'pinned', label: t('chat.sessGroupPinned'), rows: pinned },
    { key: 'live', label: t('chat.sessGroupLive'), rows: progress, count: true },
    { key: 'done', label: t('chat.sessGroupDone'), rows: done, range: true },
  ].filter((g) => g.rows.length || g.key === 'done' || (g.key === 'live' && !!f));

  const toggleFold = (key: string) => {
    const next = folded.includes(key) ? folded.filter((x) => x !== key) : [...folded, key];
    setFolded(next);
    try {
      localStorage.setItem(GROUPS_KEY, JSON.stringify(next));
    } catch {
      /* 이번 화면에서만 */
    }
  };
  const selectable = (r: SessionRow) => !r.stored;
  // 보이는 줄 순서(Shift 범위 선택의 기준)
  const visible = groups.flatMap((g) => (folded.includes(g.key) ? [] : g.key === 'done' ? g.rows.slice(0, doneShown) : g.rows)).filter(selectable);
  const toggle = (id: string, shift: boolean) => {
    setPicked((prev) => {
      const next = new Set(prev);
      const ids = visible.map((r) => r.id);
      if (shift && anchor.current && ids.includes(anchor.current)) {
        const [a, b] = [ids.indexOf(anchor.current), ids.indexOf(id)].sort((x, y) => x - y);
        for (const x of ids.slice(a, b + 1)) next.add(x);
      } else if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
    anchor.current = id;
  };
  const endSelect = () => {
    setSelecting(false);
    setPicked(new Set());
    anchor.current = '';
  };
  const closePicked = async () => {
    const chosen = all.filter((r) => picked.has(r.id));
    const busy = chosen.filter((r) => live(r.state));
    if (busy.length) {
      const ok = await confirm(t('chat.sessCloseRunningConfirm', { n: busy.length }), {
        danger: true,
        title: t('chat.sessCloseRunningTitle'),
        confirmLabel: t('chat.sessStopAndClose'),
      });
      if (!ok) return;
      for (const r of busy.filter((x) => x.state === 'running' && !x.remote)) void Promise.resolve(store.interrupt(r.id)).catch(() => undefined);
    }
    close(chosen.map((r) => r.id));
    endSelect();
  };

  const close = (ids: string[]) => {
    const current = !!store.currentId && ids.includes(store.currentId);
    store.dismissMany(ids);
    if (current) onCurrentClosed?.();
  };
  const searchSx = {
    '& .MuiOutlinedInput-root': { bgcolor: gt.searchBg, fontSize: chatType.name, '& fieldset': { borderColor: gt.searchLine } },
    '& .MuiOutlinedInput-root.Mui-focused fieldset, & .MuiOutlinedInput-root:hover fieldset': { borderColor: gt.searchFocus },
  };
  const head = f ? agentLabelOf(store, f.pod, f.profile) : null;
  const rangeChip = (r: Range, label: string) => (
    <Chip
      key={r}
      size="small"
      label={label}
      aria-pressed={range === r}
      variant={range === r ? 'filled' : 'outlined'}
      onClick={(e) => {
        e.stopPropagation();
        setRange(r);
      }}
      sx={{ height: 22, fontSize: 11 }}
    />
  );

  return (
    <Box component="nav" aria-label={t('chat.sessionsLabel')} data-guide="chat.sessions" sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1 }}>
      <Box sx={{ p: 1.25, pb: 0.75, display: 'flex', flexDirection: 'column', gap: 1 }}>
        {/* 이 칸이 누구의 세션인지. 한 AI 에이전트면 아바타·이름과 「모두 보기」 */}
        <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minHeight: 28 }}>
          {head ? <AgentAvatar name={head.colorKey} label={head.label} size={22} tone="hue" /> : null}
          <Typography component="h3" noWrap title={head?.label} sx={{ flex: 1, minWidth: 0, fontSize: chatType.name, fontWeight: 600 }}>
            {head ? t('chat.sessHeadAgent', { name: head.label }) : t('chat.sessHeadAll')}
          </Typography>
          {head ? (
            <Tooltip title={t('chat.sessShowAll')}>
              <IconButton size="small" aria-label={t('chat.sessShowAll')} onClick={() => store.setAgentFilter(null)} sx={{ color: tk.muted }}>
                <CloseIcon sx={{ fontSize: 16 }} />
              </IconButton>
            </Tooltip>
          ) : null}
          {onCollapse && (
            <Tooltip title={t('chat.sessionsCollapse')}>
              <IconButton aria-label={t('chat.sessionsCollapse')} size="small" onClick={onCollapse} sx={{ color: tk.muted }}>
                <ChevronLeftIcon fontSize="small" />
              </IconButton>
            </Tooltip>
          )}
        </Box>
        <Box sx={{ display: 'flex', gap: 0.5, alignItems: 'center' }}>
          <Tooltip title={head ? t('chat.agentNewTip', { name: head.label }) : t('chat.newSessionTip')}>
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
          <Tooltip title={t('chat.sessMenu')}>
            <IconButton aria-label={t('chat.sessMenu')} aria-haspopup="menu" aria-expanded={!!menu} size="small" onClick={(e) => setMenu(e.currentTarget)} sx={{ color: tk.muted }}>
              <MoreHorizIcon fontSize="small" />
            </IconButton>
          </Tooltip>
        </Box>
        <TextField
          size="small"
          fullWidth
          type="search"
          placeholder={t('chat.findSessionPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('chat.findSessionLabel') } }}
          sx={searchSx}
        />
      </Box>
      <Menu anchorEl={menu} open={!!menu} onClose={() => setMenu(null)}>
        <MenuItem
          onClick={() => {
            setMenu(null);
            setSelecting(true);
          }}
        >
          {t('chat.sessSelect')}
        </MenuItem>
        <MenuItem
          disabled={!finished.length}
          onClick={() => {
            setMenu(null);
            store.dismissMany(finished.map((r) => r.id));
          }}
        >
          {t('chat.sessCloseFinished', { n: finished.length })}
        </MenuItem>
      </Menu>
      <Box sx={{ px: 0.75, pb: 2, flex: 1, minHeight: 0, overflowY: 'auto' }}>
        {draft && !needle && !selecting && <Row store={store} r={null} onPick={onPick} onClose={close} oneAgent={!!f} />}
        {groups.map((g) => {
          const open = !folded.includes(g.key) || !!needle;
          const list = selecting ? g.rows.filter(selectable) : g.rows;
          const shown = g.key === 'done' ? list.slice(0, doneShown) : list;
          const allPicked = list.length > 0 && list.every((r) => picked.has(r.id));
          return (
            <Box key={g.key} component="section" aria-label={g.label} data-sess-group={g.key} sx={{ mt: 1 }}>
              <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.5, pr: 0.5 }}>
                <Box
                  component="button"
                  type="button"
                  aria-expanded={open}
                  onClick={() => toggleFold(g.key)}
                  sx={{
                    all: 'unset',
                    flex: 1,
                    display: 'flex',
                    alignItems: 'center',
                    gap: 0.5,
                    px: 1,
                    py: 0.5,
                    cursor: 'pointer',
                    fontSize: chatType.meta,
                    fontWeight: 600,
                    color: tk.muted,
                    '&:hover': { color: tk.text },
                    '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
                  }}
                >
                  <ExpandMoreIcon aria-hidden sx={{ fontSize: 16, transition: 'transform .15s', transform: open ? 'none' : 'rotate(-90deg)' }} />
                  <Box component="h3" sx={{ m: 0, font: 'inherit' }}>
                    {g.label}
                    {g.count || !open || g.range ? ` ${g.rows.length}` : ''}
                  </Box>
                </Box>
                {/* 완료 기간: 기본 어제까지, 1주일로 넓힌다(찾는 중에는 기간을 따지지 않는다) */}
                {g.range && !needle && !selecting && (
                  <Box role="group" aria-label={t('chat.sessRange')} sx={{ display: 'flex', gap: 0.5 }}>
                    {rangeChip('2d', t('chat.sessRange2d'))}
                    {rangeChip('7d', t('chat.sessRange7d'))}
                  </Box>
                )}
                {selecting && open && list.length > 0 && (
                  <Button
                    size="small"
                    onClick={() =>
                      setPicked((prev) => {
                        const next = new Set(prev);
                        for (const r of list) {
                          if (allPicked) next.delete(r.id);
                          else next.add(r.id);
                        }
                        return next;
                      })
                    }
                    sx={{ minWidth: 0, fontSize: 11, py: 0, textTransform: 'none' }}
                  >
                    {t('chat.sessSelectAll')}
                  </Button>
                )}
              </Box>
              {open &&
                shown.map((r) => (
                  <Row
                    key={r.id}
                    store={store}
                    r={r}
                    onPick={onPick}
                    onClose={close}
                    oneAgent={!!f}
                    select={{ on: selecting, checked: picked.has(r.id), toggle }}
                  />
                ))}
              {open && g.key === 'live' && !g.rows.length && !(draft && !needle) && (
                <Typography color="text.secondary" sx={{ px: 1.5, py: 0.75, fontSize: 12 }}>
                  {t('chat.sessNoneAgent')}
                </Typography>
              )}
              {open && g.key === 'done' && list.length > doneShown && (
                <Button size="small" onClick={() => setDoneShown((n) => n + DONE_PAGE)} sx={{ ml: 1, textTransform: 'none', fontSize: 12 }}>
                  {t('chat.sessMore', { n: Math.min(DONE_PAGE, list.length - doneShown) })}
                </Button>
              )}
              {open && g.key === 'done' && !needle && (
                <Box sx={{ px: 1.5, py: 0.5, display: 'flex', flexDirection: 'column', gap: 0.5 }}>
                  {loadingPast ? (
                    <Typography color="text.secondary" role="status" sx={{ fontSize: 12 }}>
                      {t('chat.sessPastLoading')}
                    </Typography>
                  ) : !g.rows.length ? (
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>
                      {t('chat.sessDoneNone')}
                    </Typography>
                  ) : null}
                  {beyond > 0 && !loadingPast ? (
                    <Box
                      component="button"
                      type="button"
                      onClick={() => setRange('7d')}
                      sx={{ all: 'unset', cursor: 'pointer', fontSize: 12, color: 'primary.main', '&:hover': { textDecoration: 'underline' }, '&:focus-visible': { outline: `2px solid ${FOCUS_RING}` } }}
                    >
                      {t('chat.sessDoneMore', { n: beyond })}
                    </Box>
                  ) : null}
                  {!f ? (
                    <Typography color="text.secondary" sx={{ fontSize: 12 }}>
                      {t('chat.sessPastHintAll')}
                    </Typography>
                  ) : null}
                </Box>
              )}
            </Box>
          );
        })}
        {needle && !rows.length && (
          <Typography color="text.secondary" sx={{ p: 2, fontSize: 13 }}>
            {t('chat.sessNoMatch')}
          </Typography>
        )}
      </Box>
      {selecting && (
        <Box
          role="toolbar"
          aria-label={t('chat.sessSelected', { n: picked.size })}
          sx={{ display: 'flex', alignItems: 'center', gap: 1, px: 1.5, py: 1, borderTop: `1px solid ${tk.line}`, bgcolor: tk.rail }}
        >
          <Typography sx={{ flex: 1, fontSize: 13, fontWeight: 600 }}>{t('chat.sessSelected', { n: picked.size })}</Typography>
          <Button size="small" onClick={endSelect} sx={{ textTransform: 'none' }}>
            {t('chat.sessCancel')}
          </Button>
          <Button size="small" variant="contained" color="error" disabled={!picked.size} onClick={() => void closePicked()} sx={{ textTransform: 'none' }}>
            {t('chat.sessCloseSelected')}
          </Button>
        </Box>
      )}
    </Box>
  );
}

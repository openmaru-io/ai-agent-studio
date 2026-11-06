/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 세션 목록: 채팅 3칸의 가운데 칸. 에이전트 칸에서 AI 에이전트를 고르면 그 에이전트 전용이 된다(2026-11-06).
// 묶음은 둘뿐이다 — 진행 중(답 필요 → 실행 중 → 열린 세션)과 완료(기본 최근 1주일, 「오늘·어제」로 좁힌다). 고정은 맨 위.
// 완료에는 이 서버가 연 세션뿐 아니라 Hermes 에 저장된 지난 세션도 든다 — 누르면 그 대화를 이어서 연다.
// 화면 다듬기(스펙 2026-11-06-002 §8): 폰 에이전트 고르기 G2, 기간 G3·G4, 줄 형식 G7·G8, 읽기 실패 G9, 닫기 되돌리기 G11.
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
  ButtonBase,
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
import { useSnackbar } from 'notistack';
import { Fragment, MouseEvent, useEffect, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { useConfirm } from '@/components/ConfirmDialog';
import { t } from '@/i18n';
import { ChatGroup, ChatStore, groupLabel, rowTitle, SessionRow, SessionState } from '@/lib/chatStore';
import { chatType, coarseTouch } from '@/lib/chatTokens';
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
const SOURCE_LABEL: Record<string, string> = { aas: 'chat.srcAas', telegram: 'chat.srcTelegram', buzz: 'chat.srcBuzz' };
/** 완료 묶음의 기간. 2d = 오늘·어제, 7d = 오늘 포함 7일. 기본은 7d — 지난주에 시작해 어제 쓴 세션이 빠지지 않게(G3) */
type Range = '2d' | '7d';
const RANGE_KEY = 'aas-chat-done-range';
function readRange(): Range {
  try {
    return localStorage.getItem(RANGE_KEY) === '2d' ? '2d' : '7d';
  } catch {
    return '7d';
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

/** 고를 수 있는 AI 에이전트(폰 세션 칸 머리의 고르기, G2). 묶음이 여럿이면 묶음마다, 아니면 지금 묶음의 프로파일 */
export function agentChoices(store: ChatStore): { pod: string; profile: string; label: string; colorKey: string }[] {
  const list: { pod?: string; a: { name: string } }[] =
    store.groups.length > 1
      ? store.groups.flatMap((g) => g.agents.map((a) => ({ pod: g.pod, a })))
      : (store.status?.agents ?? []).map((a) => ({ pod: store.status?.pod, a }));
  return list.map(({ pod, a }) => {
    const p = pod ?? store.currentPod ?? '';
    return { pod: p, profile: a.name, ...agentLabelOf(store, p || undefined, a.name) };
  });
}

/** 둘째 줄의 조각. 빈 조각은 빼고 「·」로 잇는다 — 에이전트 이름을 뺀 보기에서 「· 답 필요」처럼 앞에 점이 남았다(G8) */
export type MetaPiece = { key: string; text: string; tone?: 'warn' | 'info' };
export function rowMeta(r: SessionRow, { oneAgent, done }: { oneAgent: boolean; done: boolean }): MetaPiece[] {
  const out: MetaPiece[] = [];
  if (done) {
    // 완료 줄은 한 형식: 채널 · 메시지 n · 마지막 활동. 상태 라벨(대기 등)은 넣지 않는다(G7)
    const src = r.source || 'aas';
    out.push({ key: 'src', text: SOURCE_LABEL[src] ? t(SOURCE_LABEL[src]) : src === 'cli' ? 'CLI' : src });
    if (r.count) out.push({ key: 'count', text: t('chat.sessPastMeta', { n: r.count }) });
    out.push({ key: 'when', text: whenOf(r.at) });
  } else if (live(r.state)) {
    out.push({ key: 'state', text: t(STATE_LABEL[r.state]), tone: r.state === 'waiting' ? 'warn' : 'info' });
  } else if (oneAgent && !r.stored) {
    out.push({ key: 'state', text: t(STATE_LABEL[r.state]) });
  }
  return out.filter((p) => p.text);
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
  done,
}: {
  store: ChatStore;
  r: SessionRow | null;
  onPick: (r: SessionRow) => void;
  onClose: (ids: string[]) => void;
  /** 선택 모드: 체크칸이 보이고 줄을 누르면 고르기만 한다 */
  select?: { on: boolean; checked: boolean; toggle: (id: string, range: boolean) => void };
  /** 한 AI 에이전트의 세션만 보는 중 — 줄마다 에이전트 이름을 되풀이하지 않는다 */
  oneAgent?: boolean;
  /** 완료 묶음의 줄 — 둘째 줄을 「채널 · 메시지 n · 마지막 활동」으로(G7) */
  done?: boolean;
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
            {/* 완료 줄의 마지막 활동은 둘째 줄 끝으로 옮겼다(G7) */}
            {!draft && !done && (
              <Typography component="span" sx={{ color: tk.muted, fontSize: chatType.meta, fontVariantNumeric: 'tabular-nums', flexShrink: 0 }}>
                {whenOf(r.at)}
              </Typography>
            )}
          </Box>
          {/* 모든 AI 에이전트를 볼 때는 세션이 어느 에이전트의 것인지(아바타·이름) 뒤에 조각을 잇는다. 빈 조각은 빼고 「·」로 잇는다(G8) */}
          <Box data-row-meta="" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, mt: 0.5, minWidth: 0, color: tk.muted, fontSize: 12 }}>
            {!oneAgent && <AgentAvatar name={colorKey} label={label} size={18} tone="hue" />}
            {[...(oneAgent ? [] : [{ key: 'agent', text: label } as MetaPiece]), ...(draft ? [] : rowMeta(r, { oneAgent: !!oneAgent, done: !!done }))].map((p, i) => (
              <Fragment key={p.key}>
                {i > 0 && (
                  <Box component="span" aria-hidden sx={{ flexShrink: 0 }}>
                    ·
                  </Box>
                )}
                <Typography
                  component="span"
                  noWrap
                  title={p.key === 'agent' ? label : undefined}
                  sx={{
                    fontSize: p.tone ? 11 : 12,
                    fontWeight: p.tone ? 600 : undefined,
                    color: p.tone === 'warn' ? theme.palette.warning.main : p.tone === 'info' ? theme.palette.info.main : tk.muted,
                    minWidth: 0,
                    flexShrink: p.key === 'agent' ? 1 : 0,
                    fontVariantNumeric: p.key === 'when' ? 'tabular-nums' : undefined,
                  }}
                >
                  {p.text}
                </Typography>
              </Fragment>
            ))}
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
  agentPicker,
}: {
  store: ChatStore;
  onPick: (r: SessionRow) => void;
  onNew: () => void;
  onCollapse?: () => void;
  /** 지금 보던 세션을 닫았다 — 주소의 session 을 지운다(새로 고침 때 닫은 세션이 다시 열리지 않게) */
  onCurrentClosed?: () => void;
  /** 에이전트 칸이 없는 폭(900px 미만): 머리에 「모든 AI 에이전트 ▾」 고르기를 둔다(G2) */
  agentPicker?: boolean;
}) {
  const tk = useChatTokens();
  const gt = gridTokens[useTheme().palette.mode];
  const confirm = useConfirm();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const [q, setQ] = useState('');
  const [menu, setMenu] = useState<HTMLElement | null>(null);
  const [pickMenu, setPickMenu] = useState<HTMLElement | null>(null);
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
  // 모든 AI 에이전트 보기의 완료는 이 서버에서 끝난 세션뿐이라 기간을 따지지 않는다 — 칩도 숨긴다(G4)
  const inRange = (r: SessionRow) => !f || ageOf(r) < (range === '7d' ? 7 : 2);
  const pinned = rows.filter((r) => r.pinned);
  // 진행 중: 답 필요 → 실행 중 → 아직 열려 있는(이 서버가 받고 있는) 세션 중 오늘 활동한 것. 끝난 세션은 완료로
  const liveRows = rows.filter((r) => !r.pinned && live(r.state));
  const openToday = rows.filter((r) => !r.pinned && !live(r.state) && !r.stored && r.state !== 'closed' && (r.id === store.currentId || r.state === 'done'));
  const progress = [...liveRows.filter((r) => r.state === 'waiting'), ...liveRows.filter((r) => r.state === 'running'), ...openToday];
  const progressIds = new Set(progress.map((r) => r.id));
  const doneAll = rows.filter((r) => !r.pinned && !progressIds.has(r.id)).sort((a, b) => b.at - a.at);
  // 찾는 중에는 기간을 따지지 않는다 — 찾는 세션이 1주일 밖에 있으면 안 보였다
  const done = needle ? doneAll : doneAll.filter(inRange);
  const beyond = needle || !f || range === '7d' ? 0 : doneAll.filter((r) => ageOf(r) < 7).length - done.length;
  const draft = !!store.profile && !store.currentId && (!f || (f.profile === store.profile && (f.pod ?? '') === (store.status?.pod ?? '')));
  const finished = all.filter((r) => !live(r.state) && !r.pinned && !r.stored && r.id !== store.currentId);
  const loadingPast = !!f && store.pastLoading(f.pod, f.profile);
  const pastFailed = !!f && !loadingPast && store.pastError(f.pod, f.profile);
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

  // 닫기는 되돌릴 수 있게 한다(G11): 줄은 바로 빠지고, 알림이 닫힐 때 서버에 숨김을 남긴다. 「되돌리기」는 줄을 되살린다
  const close = (ids: string[]) => {
    if (!ids.length) return;
    const current = !!store.currentId && ids.includes(store.currentId);
    const hide = store.hideSoon(ids);
    if (current) onCurrentClosed?.();
    enqueueSnackbar(ids.length > 1 ? t('chat.sessHiddenN', { n: ids.length }) : t('chat.sessHidden'), {
      variant: 'info',
      autoHideDuration: 6000,
      onClose: () => hide.commit(),
      action: (key) => (
        <Button
          size="small"
          onClick={() => {
            hide.undo();
            closeSnackbar(key);
          }}
        >
          {t('chat.sessUndo')}
        </Button>
      ),
    });
  };
  const searchSx = {
    '& .MuiOutlinedInput-root': { bgcolor: gt.searchBg, fontSize: chatType.name, '& fieldset': { borderColor: gt.searchLine } },
    '& .MuiOutlinedInput-root.Mui-focused fieldset, & .MuiOutlinedInput-root:hover fieldset': { borderColor: gt.searchFocus },
  };
  const head = f ? agentLabelOf(store, f.pod, f.profile) : null;
  const choices = agentPicker ? agentChoices(store) : [];
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
          {agentPicker ? (
            // 폰: 에이전트 칸이 없어 머리에서 고른다(G2)
            <Typography component="h3" sx={{ flex: 1, minWidth: 0, m: 0 }}>
              {/* 메뉴를 여는 단추라 접고 펼치기(DisclosureButton)가 아니다 — ButtonBase 로 aria-expanded 를 단다 */}
              <ButtonBase
                aria-haspopup="menu"
                aria-expanded={!!pickMenu}
                aria-label={t('chat.sessPickAgent', { name: head ? head.label : t('chat.allAgentsRow') })}
                onClick={(e) => setPickMenu(e.currentTarget)}
                sx={{
                  maxWidth: '100%',
                  minHeight: 28,
                  px: 0.75,
                  gap: 0.25,
                  borderRadius: '6px',
                  color: tk.text,
                  fontSize: chatType.name,
                  fontWeight: 600,
                  '&:hover': { bgcolor: tk.hover },
                  '&.Mui-focusVisible': { outline: `2px solid ${FOCUS_RING}` },
                  ...coarseTouch,
                }}
              >
                <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                  {head ? head.label : t('chat.allAgentsRow')}
                </Box>
                <ExpandMoreIcon aria-hidden sx={{ fontSize: 18, color: tk.muted }} />
              </ButtonBase>
            </Typography>
          ) : (
            <Typography component="h3" noWrap title={head?.label} sx={{ flex: 1, minWidth: 0, fontSize: chatType.name, fontWeight: 600 }}>
              {head ? t('chat.sessHeadAgent', { name: head.label }) : t('chat.sessHeadAll')}
            </Typography>
          )}
          {head && !agentPicker ? (
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
      {agentPicker && (
        <Menu anchorEl={pickMenu} open={!!pickMenu} onClose={() => setPickMenu(null)}>
          <MenuItem
            selected={!f}
            onClick={() => {
              setPickMenu(null);
              store.setAgentFilter(null);
            }}
          >
            {t('chat.allAgentsRow')}
          </MenuItem>
          {choices.map((c) => (
            <MenuItem
              key={`${c.pod}|${c.profile}`}
              selected={!!f && f.profile === c.profile && (f.pod ?? '') === c.pod}
              onClick={() => {
                setPickMenu(null);
                store.setAgentFilter({ pod: c.pod, profile: c.profile });
              }}
              sx={{ gap: 1 }}
            >
              <AgentAvatar name={c.colorKey} label={c.label} size={20} tone="hue" />
              {c.label}
            </MenuItem>
          ))}
        </Menu>
      )}
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
            close(finished.map((r) => r.id));
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
                {/* 완료 기간: 기본 최근 1주일, 오늘·어제로 좁힌다. 찾는 중·모든 AI 에이전트 보기에는 없다(G3·G4) */}
                {g.range && !!f && !needle && !selecting && (
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
                    done={g.key === 'done'}
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
                  ) : pastFailed && f ? (
                    // 읽지 못한 것을 「끝난 세션이 없습니다」로 보이지 않는다(G9)
                    <Box role="alert" data-testid="past-error" sx={{ display: 'flex', alignItems: 'center', gap: 0.5, flexWrap: 'wrap', fontSize: 12, color: 'text.secondary' }}>
                      <span>{t('chat.sessPastFailed')}</span>
                      <span aria-hidden>·</span>
                      <Box
                        component="button"
                        type="button"
                        onClick={() => void store.loadPast(f.pod, f.profile, true)}
                        sx={{ all: 'unset', cursor: 'pointer', color: 'primary.main', '&:hover': { textDecoration: 'underline' }, '&:focus-visible': { outline: `2px solid ${FOCUS_RING}` } }}
                      >
                        {t('chat.sessPastRetry')}
                      </Box>
                    </Box>
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
                  {!f && !agentPicker ? (
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

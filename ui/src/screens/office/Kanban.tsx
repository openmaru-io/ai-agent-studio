/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 칸반: 여러 Hermes 설치본의 보드를 한 보드로 합쳐 보여 주고, 카드를 만들고 승인·중지하는 화면. 카드 실행은 Hermes 가 한다.
import AddIcon from '@mui/icons-material/Add';
import ArchiveOutlinedIcon from '@mui/icons-material/ArchiveOutlined';
import AutoAwesomeOutlinedIcon from '@mui/icons-material/AutoAwesomeOutlined';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import DeleteOutlineIcon from '@mui/icons-material/DeleteOutline';
import EditNoteOutlinedIcon from '@mui/icons-material/EditNoteOutlined';
import LockOpenOutlinedIcon from '@mui/icons-material/LockOpenOutlined';
import PlayArrowOutlinedIcon from '@mui/icons-material/PlayArrowOutlined';
import PreviewOutlinedIcon from '@mui/icons-material/PreviewOutlined';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import StopCircleOutlinedIcon from '@mui/icons-material/StopCircleOutlined';
import TaskAltOutlinedIcon from '@mui/icons-material/TaskAltOutlined';
import {
  Alert,
  AlertTitle,
  Box,
  Button,
  CircularProgress,
  Link,
  NativeSelect,
  Stack,
  TextField,
  ToggleButton,
  ToggleButtonGroup,
  Typography,
} from '@mui/material';
import { alpha, keyframes, Theme } from '@mui/material/styles';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { useSnackbar } from 'notistack';
import { useEffect, useRef, useState } from 'react';
import { useSearchParams } from 'react-router-dom';

import { AgentChip } from '@/components/AgentChip';
import { AgentPicker } from '@/components/AgentPicker';
import { KV, ScreenLoading, Tag } from '@/components/bits';
import { useConfirm } from '@/components/ConfirmDialog';
import { DisclosureButton, pressedSx } from '@/components/DisclosureButton';
import { DrawerAction, DrawerActions } from '@/components/DrawerActions';
import { FileBadge } from '@/components/files/FileBadge';
import { Markdown } from '@/components/Markdown';
import { useUi } from '@/components/UiContext';
import { useOpenParam, useParamPatch, useRouteDrawerValue } from '@/components/useRouteDrawer';
import { getLang, hasKey, localeOf, t } from '@/i18n';
import { del, get, post } from '@/lib/api';
import { useIsAdmin } from '@/lib/data';
import { displayTimeZone } from '@/lib/prefs';
import { gridTokens } from '@/lib/shellTokens';
import { useFocusOnMount } from '@/lib/useFocusOnMount';
import { useTopic } from '@/lib/ws';
import {
  BODY_LIMIT,
  BODY_WARN,
  BriefFields,
  buildCardBrief,
  CARD_BRIEF_ASK,
  CARD_BRIEF_KEYS,
  CARD_BRIEF_REQUIRED,
  CARD_BRIEF_SHOWN,
  CardBrief,
  CardBriefKey,
  missingRequired,
  parseCardBrief,
} from '@/screens/office/cardBrief';
import { Seat } from '@/screens/office/forms';

const K = '/api/office/kanban';
const COLUMN_KEY: Record<string, string> = {
  triage: 'office.colTriage',
  todo: 'office.colTodo',
  scheduled: 'office.colScheduled',
  ready: 'office.colReady',
  running: 'office.colRunning',
  blocked: 'office.colBlocked',
  review: 'office.colReview',
  done: 'office.colDone',
  archived: 'office.colArchived',
};
/** 칸 이름. 모르는 상태는 서버가 준 값을 그대로 보인다. */
export const columnLabel = (status: string): string => (COLUMN_KEY[status] ? t(COLUMN_KEY[status]) : status);

/** 기본으로 접는 칸. 사람이 손댈 일이 적거나(예약·준비) 머무는 시간이 짧다. 분류 대기는 사람 조치가 필요해 접은 줄에서 강조한다.
 *  서버가 이 밖의 상태를 주면 접지 않고 보인다(계획 2026-10-14-020). */
export const FOLDED_COLUMNS = ['triage', 'scheduled', 'ready'];
const FOLD_KEY = 'aas.kanban.folded';
const BOARD_ID = 'kanban-board';

/** 의미 신호에만 색조를 쓴다(DESIGN.md Hue Discipline, §1-3.1 아이콘 어휘): 실행 중은 초록, 막힘·담당 없음은 앰버. 나머지는 무채색. */
const SIGNAL = { running: '#27a644', warn: '#f59e0b' } as const;
const NODE_COLOR: Record<string, string | undefined> = { running: SIGNAL.running, blocked: SIGNAL.warn };
/** 앰버 글자. 라이트의 흰 면 위에서 #f59e0b 는 대비가 2:1 정도라 더 진한 값을 쓴다(점·선은 그대로) */
const warnText = (th: Theme) => (th.palette.mode === 'dark' ? SIGNAL.warn : '#b45309');
/** 글자색 위에 얹는 무채색 wash. 다크·라이트 모두 같은 식으로 쓴다 */
const ink = (a: number) => (th: Theme) => alpha(th.palette.text.primary, a);
/** 실행 중 카드가 있는 칸의 점만 천천히 맥박친다(주의를 끄는 단 한 곳) */
const pulse = keyframes`
  0% { box-shadow: 0 0 0 0 rgba(39, 166, 68, 0.45); }
  70% { box-shadow: 0 0 0 6px rgba(39, 166, 68, 0); }
  100% { box-shadow: 0 0 0 0 rgba(39, 166, 68, 0); }
`;

/** 접힘 여부. 저장값이 '0' 일 때만 펼침이고, 없거나 읽지 못하면 접힘(기본). */
export function readFolded(): boolean {
  try {
    return localStorage.getItem(FOLD_KEY) !== '0';
  } catch {
    return true;
  }
}
function writeFolded(folded: boolean) {
  try {
    if (folded) localStorage.removeItem(FOLD_KEY);
    else localStorage.setItem(FOLD_KEY, '0');
  } catch {
    /* 저장하지 못해도 화면은 이번 방문 동안 동작한다 */
  }
}

interface Card {
  id: string;
  title: string;
  body?: string | null;
  assignee: string | null;
  status: string;
  priority?: number | null;
  comment_count?: number;
  created_at?: number;
}
interface BoardView {
  columns: { name: string; tasks: Card[] }[];
}
interface BoardMeta {
  slug: string;
  name: string;
  total: number;
  archived: boolean;
}
interface Run {
  id?: number | string;
  profile?: string;
  status?: string;
  outcome?: string;
  started_at?: number;
  ended_at?: number;
  summary?: string | null; // 에이전트가 남긴 결과·막힌 사유
  error?: string | null;
}
/** 에이전트가 kanban_complete(artifacts)·kanban_attach 로 올린 결과 파일(스펙 §3-9). 서버가 Hermes 파드 안 경로는 빼고 준다 */
interface Attachment {
  id: number | string;
  filename: string;
  size?: number | null;
  content_type?: string | null;
  uploaded_by?: string | null;
  created_at?: number | null;
}
interface Detail {
  task: Card;
  comments: { id: number; author: string; body: string; created_at: number }[];
  runs: Run[];
  attachments?: Attachment[] | null;
}

/** 사람이 살펴야 하는 막힘 상태. Hermes 는 같은 사유로 두 번 막힌 카드를 blocked 가 아니라 triage 로 옮긴다(계획 2026-10-14-024 R4). */
const BLOCKED_STATES = ['blocked', 'triage'];

/** 가장 최근 실행의 위치(R6): started_at 이 큰 것, 같으면 id 가 큰 것, 그래도 같거나 id 가 없으면 배열 뒤쪽. 없으면 -1. */
export function latestRunIndex(runs: Run[]): number {
  const idOf = (r: Run) => (r.id !== undefined && r.id !== null && Number.isFinite(Number(r.id)) ? Number(r.id) : null);
  let best = -1;
  runs.forEach((r, i) => {
    if (best < 0) return void (best = i);
    const b = runs[best];
    const byTime = (r.started_at ?? 0) - (b.started_at ?? 0);
    if (byTime !== 0) return void (byTime > 0 && (best = i));
    const [ia, ib] = [idOf(r), idOf(b)];
    if (ia !== null && ib !== null && ia !== ib) return void (ia > ib && (best = i));
    best = i; // 같으면 배열 뒤쪽
  });
  return best;
}

/**
 * 막힌 사유(R2·R4·R5). 막힘 상태(blocked·triage)의 카드에서 가장 최근 실행이 남긴 글이다.
 * 실행의 outcome 이 blocked 일 때만 summary(없으면 error)를 사유로 쓴다. 그 밖의 outcome 은 이전 시도의 결과 요약일 수 있어 error 만 쓴다.
 * field 는 사유로 쓴 필드 — 실행 기록 줄 아래에서는 이 필드만 되풀이하지 않는다(다른 필드는 계속 보인다).
 */
export function blockReason(status: string, run: Run | undefined): { text: string; field: 'summary' | 'error' } | null {
  if (!BLOCKED_STATES.includes(status) || !run) return null;
  if (run.outcome === 'blocked' && run.summary) return { text: run.summary, field: 'summary' };
  if (run.error) return { text: run.error, field: 'error' };
  return null;
}

/** 실행 기록 줄의 상태 이름. Hermes 의 status·outcome 값(running·completed·timed_out 등)을 화면 언어로 바꾼다. 모르는 값은 그대로 보인다 */
export function runOutcomeLabel(value?: string | null): string {
  if (!value) return t('office.run.running');
  const key = `office.run.${value}`;
  return hasKey(key) ? t(key) : value;
}

const stamp = (sec?: number | null) =>
  sec
    ? new Date(sec * 1000).toLocaleString(localeOf(), {
        year: 'numeric', // 연도까지
        month: '2-digit',
        day: '2-digit',
        hour: '2-digit',
        minute: '2-digit',
        timeZone: displayTimeZone(), // 설정 › 일반의 날짜 표시 시간대(스펙 2026-10-14-013)
      })
    : '—';

function useRefresh() {
  const qc = useQueryClient();
  return () => qc.invalidateQueries({ queryKey: ['kanban'] });
}

/** 카드 추가 서랍의 id. 적은 내용이 있으면 닫기 전에 묻는다(setCloseGuard, 디자인 리뷰 S6) */
export const NEW_CARD_DRAWER = 'kanban-new-card';
/** 마지막으로 고른 입력 방식. 처음 방문은 항목별(R3) */
const MODE_KEY = 'aas.kanban.cardMode';
type CardMode = 'brief' | 'free';
function readMode(): CardMode {
  try {
    return localStorage.getItem(MODE_KEY) === 'free' ? 'free' : 'brief';
  } catch {
    return 'brief';
  }
}
function writeMode(m: CardMode) {
  try {
    localStorage.setItem(MODE_KEY, m);
  } catch {
    /* 기억하지 못해도 이번 서랍은 동작한다 */
  }
}
/** AI 로 항목 나누기를 다시 누를 수 있을 때까지(서버도 3초 간격을 지킨다, 디자인 리뷰 S4) */
const AI_COOLDOWN_MS = 3000;

function CardForm({
  slug,
  seats,
  isFolded,
  mySeat,
  admin,
}: {
  slug: string;
  seats: Seat[];
  isFolded: () => boolean;
  /** 담당의 처음 값: 내 에이전트의 자리(OMAI-1286). 목록에 없으면 비운다 */
  mySeat?: string;
  /** 관리자만 담당 없이(분류 대기) 만들 수 있다. 서버도 같은 규칙으로 거절한다 */
  admin: boolean;
}) {
  const { closeDrawer, setCloseGuard } = useUi();
  const confirm = useConfirm();
  const { enqueueSnackbar } = useSnackbar();
  const refresh = useRefresh();
  const [title, setTitle] = useState('');
  const [body, setBody] = useState('');
  const [brief, setBrief] = useState<CardBrief>({});
  const [mode, setModeState] = useState<CardMode>(readMode);
  const [more, setMore] = useState(false);
  const [preview, setPreview] = useState(false);
  const [assignee, setAssignee] = useState(() => (mySeat && seats.some((s) => s.enabled && s.alias === mySeat) ? mySeat : ''));
  const [priority, setPriority] = useState('0');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  // AI 로 항목 나누기(§3-7): 기다리는 동안은 다른 조작을 잠근다. 늦게 온 답은 요청 번호로 버린다(api.post 는 요청을 끊지 못한다)
  const [aiBusy, setAiBusy] = useState(false);
  const [aiCooling, setAiCooling] = useState(false);
  const [aiError, setAiError] = useState('');
  const [aiStatus, setAiStatus] = useState('');
  const [aiFilled, setAiFilled] = useState<Set<CardBriefKey>>(new Set());
  const [aiMissing, setAiMissing] = useState<Set<CardBriefKey>>(new Set());
  const asked = useRef(0);
  const lastBuilt = useRef('');
  const fieldRefs = useRef(
    Object.fromEntries(CARD_BRIEF_KEYS.map((k) => [k, { current: null as HTMLInputElement | null }])) as Record<CardBriefKey, { current: HTMLInputElement | null }>
  ).current;
  // AI 결과 뒤 옮길 칸. 바뀐 화면(항목별 입력·펼친 칸)이 그려진 뒤에 옮긴다 — setTimeout(…, 0) 은 그리기보다 먼저 돌 수 있어
  // 부하가 있으면 칸이 아직 없어 포커스가 옮겨지지 않았다(2026-10-22, 스펙 2026-10-21-015 단계 6)
  const [focusField, setFocusField] = useState<CardBriefKey | null>(null);
  useEffect(() => {
    const el = focusField ? fieldRefs[focusField].current : null;
    if (!el) return;
    el.focus();
    setFocusField(null);
  }, [focusField, mode, more, fieldRefs]);

  const built = buildCardBrief(brief);
  const text = mode === 'brief' ? built : body;
  const dirty = !!(title.trim() || body.trim() || built);
  // 닫기 확인은 늘 마지막 값을 본다
  const dirtyRef = useRef(dirty);
  dirtyRef.current = dirty;
  useEffect(() => {
    const counter = asked;
    setCloseGuard(NEW_CARD_DRAWER, async () => !dirtyRef.current || (await confirm(t('office.cardDiscardConfirm'))));
    return () => {
      counter.current++; // 서랍이 닫히면 늦게 온 AI 답을 버린다
      setCloseGuard(NEW_CARD_DRAWER, null);
    };
  }, [confirm, setCloseGuard]);

  const setMode = (m: CardMode) => {
    setModeState(m);
    writeMode(m);
  };
  const setField = (k: CardBriefKey, v: string) => {
    setBrief((b) => ({ ...b, [k]: v }));
    // 사람이 고친 칸은 「AI 가 채움」·빠진 항목 안내를 지운다
    setAiFilled((s) => (s.has(k) ? new Set([...s].filter((x) => x !== k)) : s));
    setAiMissing((s) => (s.has(k) && v.trim() ? new Set([...s].filter((x) => x !== k)) : s));
  };

  // 방식을 오갈 때(디자인 리뷰 J2): 화면이 만든 글은 머리로 되돌리고, 사람이 적은 글을 덮기 전에는 묻는다. 포커스는 토글에 남는다(D19)
  const switchMode = async (next: CardMode) => {
    if (next === mode) return;
    if (next === 'free') {
      if (built && (!body.trim() || body === lastBuilt.current || (await confirm(t('office.cardToFreeConfirm'))))) {
        setBody(built);
        lastBuilt.current = built;
      }
    } else if (body.trim()) {
      const parsed = parseCardBrief(body);
      const clash = CARD_BRIEF_KEYS.some((k) => parsed[k] && brief[k]?.trim() && brief[k]!.trim() !== parsed[k]);
      if (!clash || (await confirm(t('office.cardToBriefConfirm')))) {
        setBrief((b) => ({ ...b, ...parsed }));
        if (CARD_BRIEF_KEYS.some((k) => !CARD_BRIEF_SHOWN.includes(k) && parsed[k])) setMore(true);
      }
    }
    setMode(next);
  };

  const askAi = async () => {
    if (built && !(await confirm(t('office.cardAiOverwrite')))) return;
    const id = ++asked.current;
    setAiBusy(true);
    setAiError('');
    setAiStatus('');
    try {
      const out = await post<{ fields: CardBrief; missing: CardBriefKey[] }>('/api/office/brief/suggest', { title, text: body, lang: getLang() });
      if (id !== asked.current) return;
      const fields: CardBrief = {};
      for (const k of CARD_BRIEF_KEYS) if (out.fields?.[k]?.trim()) fields[k] = out.fields[k]!.trim();
      const filled = CARD_BRIEF_KEYS.filter((k) => fields[k]);
      const missing = (out.missing ?? []).filter((k) => CARD_BRIEF_ASK.includes(k) && !fields[k]);
      setBrief(fields);
      setAiFilled(new Set(filled));
      setAiMissing(new Set(missing));
      if (filled.some((k) => !CARD_BRIEF_SHOWN.includes(k))) setMore(true);
      setMode('brief');
      setAiStatus(t('office.cardAiSummary', { count: filled.length }));
      // 고칠 곳으로 바로 간다: 처음 빠진 필수 칸, 없으면 목표 칸(D19)
      const target = missing.find((k) => CARD_BRIEF_REQUIRED.includes(k)) ?? 'goal';
      setFocusField(target);
      setAiCooling(true);
      setTimeout(() => setAiCooling(false), AI_COOLDOWN_MS);
    } catch (e) {
      if (id === asked.current) setAiError((e as Error).message);
    } finally {
      if (id === asked.current) setAiBusy(false);
    }
  };
  const cancelAi = () => {
    asked.current++;
    setAiBusy(false);
  };

  const need = [
    ...(title.trim() ? [] : [t('office.cardTitleLabel')]),
    ...(mode === 'brief' ? missingRequired(brief).map((k) => t(`office.cardBrief.${k}.head`)) : []),
  ];
  const needAssignee = !admin && !assignee;
  const needText =
    need.length && needAssignee
      ? t('office.cardNeedBoth', { fields: need.join(', ') })
      : need.length
        ? t('office.cardNeedFields', { fields: need.join(', ') })
        : needAssignee
          ? t('office.cardNeedAssignee')
          : '';

  const save = async () => {
    setBusy(true);
    try {
      const res = await post<{ task?: { status?: string } }>(`${K}/tasks?board=${encodeURIComponent(slug)}`, {
        title,
        // 자유 입력은 지금과 같은 값을 보낸다(R3 회귀 계약)
        body: text,
        assignee: assignee || undefined,
        priority,
      });
      // 담당이 있으면 준비, 없으면 분류 대기로 들어가 둘 다 접혀 있으면 카드가 사라진 것처럼 보인다. 어느 칸인지 알린다(계획 2026-10-14-020 §3-5)
      const status = res?.task?.status;
      const message = !status
        ? t('office.cardCreated', { title })
        : FOLDED_COLUMNS.includes(status) && isFolded()
          ? t('office.cardCreatedFolded', { title, column: columnLabel(status) })
          : t('office.cardCreatedIn', { title, column: columnLabel(status) });
      enqueueSnackbar(message, { variant: 'success' });
      setCloseGuard(NEW_CARD_DRAWER, null); // 만든 뒤에는 묻지 않는다
      await closeDrawer();
      await refresh();
    } catch (e) {
      setError((e as Error).message);
      setBusy(false);
    }
  };

  const priorityField = (
    <TextField
      size="small"
      type="number"
      label={t('office.cardPriorityLabel')}
      value={priority}
      onChange={(e) => setPriority(e.target.value)}
      helperText={t('office.cardPriorityHint')}
      slotProps={{ inputLabel: { shrink: true } }}
    />
  );
  const notes: Partial<Record<CardBriefKey, { text: string; warn: boolean }>> = {};
  for (const k of aiFilled) notes[k] = { text: t('office.cardAiFilled'), warn: false };
  for (const k of aiMissing) notes[k] = { text: t(`office.cardAiMissing.${k}`), warn: true };
  const length = text.length;

  return (
    <Stack spacing={1.5}>
      <TextField
        size="small"
        label={t('office.cardTitleLabel')}
        placeholder={t('office.cardTitleExample')}
        value={title}
        onChange={(e) => setTitle(e.target.value)}
        slotProps={{ inputLabel: { shrink: true } }}
      />
      <AgentPicker
        label={t('office.cardAssigneeLabel')}
        value={assignee}
        onChange={setAssignee}
        options={seats.filter((s) => s.enabled).map((s) => ({ value: s.alias, label: seatOption(s) }))}
        emptyLabel={admin ? t('office.cardNoAssignee') : undefined}
      />
      {admin && !assignee && (
        <Typography variant="caption" color="text.secondary">
          {t('office.cardNoAssigneeHint')}
        </Typography>
      )}
      <ToggleButtonGroup
        exclusive
        size="small"
        fullWidth
        value={mode}
        disabled={aiBusy}
        aria-label={t('office.cardModeLabel')}
        onChange={(_, v: CardMode | null) => {
          if (v) void switchMode(v);
        }}
      >
        <ToggleButton value="brief">
          {t('office.cardModeBrief')}
        </ToggleButton>
        <ToggleButton value="free">
          {t('office.cardModeFree')}
        </ToggleButton>
      </ToggleButtonGroup>
      {aiStatus && mode === 'brief' && (
        <Typography variant="body2" role="status">
          {aiStatus}
        </Typography>
      )}
      {preview ? (
        <Box sx={{ border: 1, borderColor: 'divider', borderRadius: 1.5, p: 1.5 }}>
          <Typography variant="subtitle2">{title || '—'}</Typography>
          {text ? <Markdown text={text} dense /> : <Typography variant="body2" color="text.secondary">{t('office.cardPreviewEmpty')}</Typography>}
        </Box>
      ) : mode === 'brief' ? (
        <BriefFields values={brief} onChange={setField} more={more} onMore={() => setMore((v) => !v)} notes={notes} refs={fieldRefs} extra={priorityField} disabled={aiBusy} />
      ) : (
        <>
          <TextField
            size="small"
            label={t('office.cardBodyLabel')}
            placeholder={t('office.cardBodyExample')}
            multiline
            minRows={3}
            value={body}
            disabled={aiBusy}
            onChange={(e) => setBody(e.target.value)}
            slotProps={{ inputLabel: { shrink: true } }}
          />
          <Stack direction="row" spacing={1} alignItems="center">
            <Button
              variant="outlined"
              size="small"
              startIcon={aiBusy ? <CircularProgress size={16} /> : <AutoAwesomeOutlinedIcon />}
              disabled={!body.trim() || aiBusy || aiCooling}
              aria-busy={aiBusy}
              onClick={() => void askAi()}
            >
              {t('office.cardAiSplit')}
            </Button>
            {aiBusy && (
              <Button size="small" color="inherit" onClick={cancelAi}>
                {t('common.cancel')}
              </Button>
            )}
          </Stack>
          {aiError && (
            <Alert severity="error" role="alert">
              {aiError}
            </Alert>
          )}
          {priorityField}
        </>
      )}
      <Stack direction="row" alignItems="center" justifyContent="space-between">
        <Typography variant="caption" color={length > BODY_WARN ? 'warning.main' : 'text.secondary'} role={length > BODY_WARN ? 'status' : undefined}>
          {t('office.cardChars', { count: length.toLocaleString(localeOf()), limit: BODY_LIMIT.toLocaleString(localeOf()) })}
          {length > BODY_WARN ? ` ${t('office.cardTooLong')}` : ''}
        </Typography>
        <Button size="small" color="inherit" startIcon={<PreviewOutlinedIcon />} aria-pressed={preview} onClick={() => setPreview((v) => !v)} sx={pressedSx}>
          {t('office.cardPreview')}
        </Button>
      </Stack>
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<AddIcon />} variant="contained" disabled={busy || aiBusy || !!needText} onClick={save}>
          {t('office.create')}
        </Button>
        {needText && (
          <Typography component="span" variant="caption" color="text.secondary" sx={{ ml: 1.5 }}>
            {needText}
            {mode === 'brief' && missingRequired(brief).length > 0 && (
              <>
                {' '}
                <Link component="button" type="button" variant="caption" onClick={() => void switchMode('free')}>
                  {t('office.cardToFree')}
                </Link>
              </>
            )}
          </Typography>
        )}
      </Box>
      <Typography variant="caption" color="text.secondary">
        {t('office.cardFormNote')}
      </Typography>
    </Stack>
  );
}

/** 변경 요청·막힘 풀기에 남길 말. 서랍 머리 단추의 대화 상자 안에 그린다(OMAI-1135) */
function NoteForm({ label, okLabel, required, onSubmit }: { label: string; okLabel: string; required: boolean; onSubmit: (note: string) => Promise<unknown> }) {
  const [note, setNote] = useState('');
  const [busy, setBusy] = useState(false);
  const first = useFocusOnMount<HTMLInputElement>();
  return (
    <Stack direction="row" spacing={1} sx={{ pt: 0.5 }}>
      <TextField
        size="small"
        fullWidth
        multiline
        inputRef={first}
        label={label}
        value={note}
        onChange={(e) => setNote(e.target.value)}
      />
      <Button
        variant="contained"
        disabled={busy || (required && !note.trim())}
        onClick={async () => {
          setBusy(true);
          await onSubmit(note);
        }}
      >
        {okLabel}
      </Button>
    </Stack>
  );
}

/** Hermes 첨부 한도(KANBAN_ATTACHMENT_MAX_BYTES). 넘는 첨부는 미리 막는다(디자인 리뷰 A2) */
const ATTACH_MAX = 25 * 1024 * 1024;
const ATTACH_LIST_MAX = 10;



/** 카드 서랍의 「첨부 (N)」. 표·막힘 사유 아래, 본문 위(디자인 리뷰 U3). 줄은 두 줄: 이름·내려받기 / 올린 프로파일·크기·시각(A1) */
function attachReason(code?: string | null): string {
  const key = `office.attach.reason.${code || 'unknown'}`;
  return hasKey(key) ? t(key) : t('office.attach.reason.unknown');
}

function Attachments({ slug, taskId, items, seats }: { slug: string; taskId: string; items: Attachment[]; seats: Seat[] }) {
  const url = (a: Attachment) =>
    `${K}/tasks/${encodeURIComponent(taskId)}/attachments/${encodeURIComponent(String(a.id))}?board=${encodeURIComponent(slug)}`;
  // 이름은 파일 뱃지, 누르면 파일 뷰어(스펙 2026-10-20-002 리뷰 R1). 25MB 를 넘으면 뷰어가 받지 않고 이유를 보인다
  return (
    <Box>
      <Typography variant="subtitle2">{t('office.attachHeading', { count: items.length })}</Typography>
      <Box sx={items.length > ATTACH_LIST_MAX ? { maxHeight: 360, overflowY: 'auto' } : undefined}>
        {items.map((a) => {
          const big = (a.size ?? 0) > ATTACH_MAX;
          return (
            <Box key={String(a.id)} sx={{ py: 0.5 }}>
              <FileBadge
                file={{ name: a.filename, url: url(a), size: a.size ?? undefined, source: 'kanban', place: slug, blocked: big ? 'too_large' : undefined, reasonOf: (c) => (c === 'too_large' ? t('office.attachTooLarge') : attachReason(c)) }}
                maxName="100%"
                ellipsis={48}
              />
              <Stack direction="row" alignItems="center" spacing={1} sx={{ color: 'text.secondary', mt: 0.25 }}>
                {/* 에이전트 칩은 자리(프로파일)일 때만. 그 밖의 값(dashboard·사람이 CLI 로 적은 이름)은 글자로 보인다(§8-4) */}
                {a.uploaded_by && seats.some((s) => s.alias === a.uploaded_by) ? (
                  <AssigneeChip alias={a.uploaded_by} names={seatNames(seats)} />
                ) : a.uploaded_by ? (
                  <Typography variant="caption">{a.uploaded_by}</Typography>
                ) : null}
                {a.created_at ? <Typography variant="caption">{stamp(a.created_at)}</Typography> : null}
              </Stack>
            </Box>
          );
        })}
      </Box>
    </Box>
  );
}

function CardDetail({ slug, id, seats, canAct }: { slug: string; id: string; seats: Seat[]; canAct: boolean }) {
  const confirm = useConfirm();
  const { closeDrawer } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const refresh = useRefresh();
  const q = useQuery<Detail>({
    queryKey: ['kanban', 'task', slug, id],
    queryFn: () => get<Detail>(`${K}/tasks/${encodeURIComponent(id)}?board=${encodeURIComponent(slug)}`),
  });
  const [comment, setComment] = useState('');
  const [to, setTo] = useState('');
  const [error, setError] = useState('');
  const d = q.data;
  if (!d) return q.error ? <Alert severity="error">{q.error.message}</Alert> : <Typography>{t('office.loading')}</Typography>;
  const task = d.task;
  // 막힌 카드는 가장 최근 실행이 남긴 사유(없으면 오류)를 서랍 위쪽에 보인다(계획 2026-10-14-024). 사람이 막힘을 풀기 전에 읽어야 한다
  const latestIdx = latestRunIndex(d.runs);
  const names = seatNames(seats);
  const reason = blockReason(task.status, d.runs[latestIdx]);
  const base = `${K}/tasks/${encodeURIComponent(id)}`;
  const qs = `?board=${encodeURIComponent(slug)}`;

  const run = async (fn: () => Promise<unknown>, ok: string, close = false) => {
    setError('');
    try {
      const res = (await fn()) as { task?: { id?: string } } | undefined;
      enqueueSnackbar(ok, { variant: 'success' });
      setComment('');
      await refresh();
      // 담당 없는 카드를 다른 설치본의 에이전트에게 넘기면 카드 번호가 바뀐다. 옛 번호의 서랍은 닫는다
      if (close || (res?.task?.id && res.task.id !== task.id)) closeDrawer();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  const act = (name: string, body: object, ok: string) => run(() => post(`${base}/${name}${qs}`, body), ok);

  // 카드 동작은 서랍 머리의 아이콘 단추로 두고, 누르면 대화 상자에서 확인한 뒤 진행한다(COP Drawer 처럼, OMAI-1135)
  const st = task.status;
  const actions: DrawerAction[] = !canAct
    ? []
    : [
        ...(st === 'running'
          ? [
              {
                id: 'stop',
                label: t('office.cardStop'),
                description: t('office.cardStopTip'),
                icon: StopCircleOutlinedIcon,
                danger: true,
                confirm: { message: t('office.cardStopConfirm'), okLabel: t('office.cardStop'), onConfirm: () => act('terminate', {}, t('office.cardStopped', { title: task.title })) },
              },
            ]
          : []),
        ...(st === 'review'
          ? [
              {
                id: 'approve',
                label: t('office.cardApprove'),
                description: t('office.cardApproveTip'),
                icon: TaskAltOutlinedIcon,
                confirm: {
                  message: t('office.cardApproveConfirm', { title: task.title }),
                  okLabel: t('office.cardApprove'),
                  onConfirm: () => act('approve', {}, t('office.cardApproved', { title: task.title })),
                },
              },
              {
                id: 'request-changes',
                label: t('office.cardRequestChanges'),
                description: t('office.cardRequestChangesTip'),
                icon: EditNoteOutlinedIcon,
                dialog: {
                  render: (close: () => void) => (
                    <NoteForm
                      label={t('office.cardChangeNoteLabel')}
                      okLabel={t('office.cardRequestChanges')}
                      required
                      onSubmit={(note) => act('request-changes', { comment: note }, t('office.cardChangesRequested', { title: task.title })).then(close)}
                    />
                  ),
                },
              },
            ]
          : []),
        ...(st === 'blocked'
          ? [
              {
                id: 'unblock',
                label: t('office.cardUnblock'),
                description: t('office.cardUnblockTip'),
                icon: LockOpenOutlinedIcon,
                dialog: {
                  render: (close: () => void) => (
                    <NoteForm
                      label={t('office.cardUnblockNoteLabel')}
                      okLabel={t('office.cardUnblock')}
                      required={false}
                      onSubmit={(note) => act('unblock', { comment: note }, t('office.cardUnblocked', { title: task.title })).then(close)}
                    />
                  ),
                },
              },
            ]
          : []),
        ...(st === 'done'
          ? [
              {
                id: 'archive',
                label: t('office.cardArchive'),
                description: t('office.cardArchiveTip'),
                icon: ArchiveOutlinedIcon,
                confirm: {
                  message: t('office.cardArchiveConfirm', { title: task.title }),
                  okLabel: t('office.cardArchive'),
                  onConfirm: () => run(() => post(`${base}/archive${qs}`, {}), t('office.cardArchived', { title: task.title }), true),
                },
              },
            ]
          : []),
        {
          id: 'delete',
          label: t('office.cardDelete'),
          description: t('office.cardDeleteTip'),
          icon: DeleteOutlineIcon,
          danger: true,
          confirm: {
            message: t('office.cardDeleteConfirm', { title: task.title }),
            okLabel: t('office.cardDelete'),
            onConfirm: () => run(() => del(`${base}${qs}`), t('office.cardDeleted', { title: task.title }), true),
          },
        },
      ];

  return (
    <Stack spacing={1.5}>
      <DrawerActions actions={actions} />
      <KV
        pairs={[
          [t('office.cardStatus'), <Tag key="s">{columnLabel(task.status)}</Tag>],
          [t('office.cardAssignee'), task.assignee ? <AssigneeChip key="a" alias={task.assignee} names={seatNames(seats)} /> : t('office.cardNoneAssignee')],
          [t('office.cardPriority'), task.priority ?? 0],
          [t('office.cardCreatedAt'), stamp(task.created_at)],
        ]}
      />
      {reason && (
        // 서랍을 열 때 읽히는 안내라 role=status 다(오류가 아니라 사람이 풀 상태). 긴 글은 상자 안에서 스크롤한다
        <Alert severity="warning" role="status">
          <AlertTitle>{t('office.blockedReason')}</AlertTitle>
          {/* 에이전트가 쓴 글이라 마크다운·HTML 로 해석하지 않고 그대로 보인다 */}
          <Typography
            variant="body2"
            component="div"
            // eslint-disable-next-line jsx-a11y/no-noninteractive-tabindex -- 키보드로도 긴 글을 스크롤할 수 있어야 한다
            tabIndex={0}
            sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word', maxHeight: 180, overflowY: 'auto' }}
          >
            {reason.text}
          </Typography>
        </Alert>
      )}
      {d.attachments && d.attachments.length > 0 && <Attachments slug={slug} taskId={id} items={d.attachments} seats={seats} />}
      {task.body ? <Markdown text={task.body} dense /> : null}
      {error && <Alert severity="error">{error}</Alert>}
      {canAct && task.status !== 'archived' && task.status !== 'running' && (
        <Stack direction="row" spacing={1}>
          <AgentPicker
            label={t('office.cardOtherAssignee')}
            value={to}
            onChange={setTo}
            options={seats.filter((s) => s.enabled && s.alias !== task.assignee).map((s) => ({ value: s.alias, label: seatOption(s) }))}
            emptyLabel={t('office.cardReassignPlaceholder')}
            sx={{ flex: 1 }}
          />
          <Button
            variant="outlined"
            disabled={!to}
            onClick={async () => {
              // 담당을 바꾸면 다른 에이전트가 카드를 맡아 실행하므로 확인한다(OMAI-1135)
              const toName = seatNames(seats).get(to) ?? to; // 확인창·알림도 별칭 대신 이름(스펙 2026-10-19-003)
              if (await confirm(t('office.cardReassignConfirm', { title: task.title, to: toName })))
                await act('reassign', { profile: to }, t('office.cardReassigned', { title: task.title, to: toName }));
            }}
          >
            {t('office.cardReassign')}
          </Button>
        </Stack>
      )}
      <Box>
        <Typography variant="subtitle2">{t('office.commentsHeading', { count: d.comments.length })}</Typography>
        {d.comments.map((c) => (
          <Box key={c.id} sx={{ py: 0.5 }}>
            {/* 작성자는 자리면 기본 정보 표의 담당처럼 칩, 아니면(aas·사람이 CLI 로 적은 이름) 글자 그대로. 본문은 카드 본문처럼 마크다운으로 그린다(HTML 은 실행하지 않는다) */}
            <Stack direction="row" alignItems="center" spacing={1} sx={{ color: 'text.secondary' }}>
              <NameChip value={c.author} names={names} />
              <Typography variant="caption">{stamp(c.created_at)}</Typography>
            </Stack>
            {c.body ? <Markdown text={c.body} dense /> : null}
          </Box>
        ))}
        {canAct && (
          <Stack direction="row" spacing={1} sx={{ mt: 1 }}>
            <TextField
              size="small"
              fullWidth
              label={t('office.commentLabel')}
              value={comment}
              onChange={(e) => setComment(e.target.value)}
            />
            <Button startIcon={<SendOutlinedIcon />}
              variant="outlined"
              // 서랍이 좁아지면 글자가 두 줄로 꺾였다(2026-10-15). 줄어들지 않게 하고 입력 칸 높이에 맞춰 키운다
              sx={{ flexShrink: 0, whiteSpace: 'nowrap', minWidth: 88, px: 2.5, fontSize: 14 }}
              disabled={!comment.trim()}
              onClick={() => run(() => post(`${base}/comments${qs}`, { body: comment }), t('office.commentPosted', { title: task.title }))}
            >
              {t('office.commentPost')}
            </Button>
          </Stack>
        )}
      </Box>
      {d.runs.length > 0 && (
        <Box>
          <Typography variant="subtitle2">{t('office.runsHeading', { count: d.runs.length })}</Typography>
          {d.runs.map((r, i) => (
            <Box key={r.id ?? i} sx={{ py: 0.25 }}>
              {/* 이름·상태는 기본 정보 표의 담당·상태처럼 칩으로 보인다 */}
              <Stack direction="row" alignItems="center" spacing={1}>
                {r.profile ? <NameChip value={r.profile} names={names} /> : <Typography variant="caption">—</Typography>}
                <Tag>{runOutcomeLabel(r.outcome ?? r.status)}</Tag>
                <Typography variant="caption" color="text.secondary">{stamp(r.started_at)}</Typography>
              </Stack>
              {/* 막힌 사유로 위에 이미 보인 글만 되풀이하지 않는다. 같은 실행의 다른 필드(예: 요약이 사유일 때의 오류)는 계속 보인다 */}
              {r.summary && !(reason?.field === 'summary' && i === latestIdx) ? (
                <Typography variant="caption" color="text.secondary" component="div" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {r.summary}
                </Typography>
              ) : null}
              {r.error && !(reason?.field === 'error' && i === latestIdx) ? (
                <Typography variant="caption" color="error" component="div" sx={{ whiteSpace: 'pre-wrap', wordBreak: 'break-word' }}>
                  {r.error}
                </Typography>
              ) : null}
            </Box>
          ))}
        </Box>
      )}
    </Stack>
  );
}

function NewBoard() {
  const { closeDrawer } = useUi();
  const [, setParams] = useSearchParams();
  const refresh = useRefresh();
  const [name, setName] = useState('');
  const [error, setError] = useState('');
  const create = async () => {
    const slug =
      'office-' +
      Array.from(crypto.getRandomValues(new Uint8Array(6)), (b) => b.toString(16).padStart(2, '0')).join('');
    try {
      await post(`${K}/boards`, { slug, name });
      await refresh();
      setParams({ tab: 'kanban', board: slug }, { replace: true });
      closeDrawer();
    } catch (e) {
      setError((e as Error).message);
    }
  };
  return (
    <Stack spacing={1.5}>
      <TextField size="small" label={t('office.boardNameLabel')} value={name} onChange={(e) => setName(e.target.value)} />
      {error && <Alert severity="error">{error}</Alert>}
      <Box>
        <Button startIcon={<AddIcon />} variant="contained" disabled={!name.trim()} onClick={create}>
          {t('office.create')}
        </Button>
      </Box>
    </Stack>
  );
}

/** 접은 칸 한 줄. 접힌 동안은 숨긴 칸의 카드 수를 숫자로 보이고(분류 대기가 있으면 앰버), 오른쪽 단추 하나로 연다. */
function FoldedStrip({ hidden, folded, onToggle }: { hidden: BoardView['columns']; folded: boolean; onToggle: () => void }) {
  const list = hidden.map((c) => `${columnLabel(c.name)} ${c.tasks.length}`).join(', ');
  return (
    <Stack direction="row" alignItems="center" spacing={2} role="group" aria-label={t('office.foldedLabel')} sx={{ minHeight: 32 }}>
      {folded && (
        <>
          <Typography variant="caption" color="text.secondary">
            {t('office.foldedLabel')}
          </Typography>
          <Stack component="ul" direction="row" spacing={2.5} sx={{ m: 0, p: 0, listStyle: 'none' }}>
            {hidden.map((c) => {
              const n = c.tasks.length;
              const warn = c.name === 'triage' && n > 0;
              return (
                <Typography
                  key={c.name}
                  component="li"
                  variant="caption"
                  color="text.secondary"
                  data-tone={warn ? 'warn' : undefined}
                >
                  {`${columnLabel(c.name)} `}
                  <Box
                    component="b"
                    sx={(th) => ({ fontWeight: 600, fontVariantNumeric: 'tabular-nums', color: warn ? warnText(th) : n ? th.palette.text.primary : th.palette.text.disabled })}
                  >
                    {n}
                  </Box>
                </Typography>
              );
            })}
          </Stack>
        </>
      )}
      {/* 펼침 아이콘은 글자 앞(스펙 2026-10-19-005 R4), 색은 지금처럼 기본색(R8) */}
      <DisclosureButton
        open={!folded}
        onToggle={onToggle}
        controls={BOARD_ID}
        color="primary"
        aria-label={folded ? t('office.foldedShowAria', { count: hidden.length, list }) : undefined}
        sx={{ ml: 'auto !important' }}
        label={folded ? t('office.foldedShow') : t('office.foldedHide')}
      />
    </Stack>
  );
}

/** 담당(별칭) → 화면에 보일 에이전트 이름. 서버가 자리마다 주는 label(2026-10-18-010)을 쓰고, 자리가 없으면 별칭 그대로. */
function seatNames(seats: Seat[]): Map<string, string> {
  return new Map(seats.map((s) => [s.alias, s.label || s.alias]));
}
/** 담당 칩. 이름을 보이고 점 색은 별칭 기준(다른 화면과 같은 에이전트는 같은 색), 별칭은 풍선말. */
function AssigneeChip({ alias, names }: { alias: string; names: Map<string, string> }) {
  const label = names.get(alias) ?? alias;
  return <AgentChip name={label} colorKey={alias} title={label !== alias ? alias : undefined} size="sm" />;
}
/** 자리 별칭이면 담당 칩, 자리가 아닌 이름(aas·사람이 CLI 로 적은 이름)이면 글자 그대로 */
function NameChip({ value, names }: { value: string; names: Map<string, string> }) {
  return names.has(value) ? <AssigneeChip alias={value} names={names} /> : <Typography variant="caption">{value}</Typography>;
}
/** 담당 고르기 목록의 글자: 서버가 준 이름(자동 별칭이면 에이전트 이름, 지은 별칭이면 별칭). 설치본 id 는 붙이지 않는다(스펙 2026-10-19-003) */
const seatOption = (s: Seat) => s.label || s.alias;

/** 카드 한 장. 한 단 올린 면 + 얇은 선. 담당은 이니셜 상자, 담당이 없으면 앰버 점. */
function TaskCard({ card, names, onOpen }: { card: Card; names: Map<string, string>; onOpen: () => void }) {
  const name = card.assignee ?? '';
  return (
    <Box
      component="button"
      type="button"
      onClick={onOpen}
      sx={(th) => ({
        display: 'flex',
        flexDirection: 'column',
        gap: 1,
        width: '100%',
        p: '10px 12px',
        textAlign: 'left',
        font: 'inherit',
        color: 'inherit',
        cursor: 'pointer',
        bgcolor: 'background.paper',
        border: `1px solid ${alpha(th.palette.text.primary, 0.08)}`,
        borderRadius: '6px',
        transition: 'border-color 120ms ease, background-color 120ms ease',
        '&:hover': { borderColor: alpha(th.palette.text.primary, 0.18), backgroundColor: `color-mix(in srgb, ${th.palette.background.paper}, ${th.palette.text.primary} 4%)` },
        '&:focus-visible': { outline: `2px solid ${gridTokens[th.palette.mode].focusRing}`, outlineOffset: 2 },
        '@media (prefers-reduced-motion: reduce)': { transition: 'none' },
      })}
    >
      <Typography
        variant="body2"
        sx={{ fontWeight: 500, lineHeight: 1.45, display: '-webkit-box', WebkitLineClamp: 2, WebkitBoxOrient: 'vertical', overflow: 'hidden', wordBreak: 'break-word' }}
      >
        {card.title}
      </Typography>
      <Stack direction="row" alignItems="center" spacing={0.75} sx={{ minHeight: 18 }}>
        {name ? (
          <AssigneeChip alias={name} names={names} />
        ) : (
          <>
            <Box aria-hidden sx={{ width: 6, height: 6, borderRadius: '50%', bgcolor: SIGNAL.warn, flex: 'none' }} />
            <Typography variant="caption" sx={{ color: warnText }}>
              {t('office.cardNoAssigneeShort')}
            </Typography>
          </>
        )}
        <Stack direction="row" alignItems="center" spacing={1} sx={{ ml: 'auto !important', color: 'text.secondary', flex: 'none' }}>
          {card.priority ? (
            <Typography variant="caption" color="inherit">
              {t('office.cardPriorityTag', { n: card.priority })}
            </Typography>
          ) : null}
          {card.comment_count ? (
            <Stack direction="row" alignItems="center" spacing={0.5} aria-label={t('office.cardCommentsTag', { count: card.comment_count })}>
              <ChatBubbleOutlineIcon aria-hidden sx={{ fontSize: 13 }} />
              <Typography variant="caption" color="inherit" sx={{ fontVariantNumeric: 'tabular-nums' }}>
                {card.comment_count}
              </Typography>
            </Stack>
          ) : null}
        </Stack>
      </Stack>
    </Box>
  );
}

/** 칸 하나. 상자가 아니라 흐름 선에 매달린 줄이다. 머리: 상태 점(선 위) + 이름 + 카드 수. */
function Lane({ col, names, onOpen }: { col: BoardView['columns'][number]; names: Map<string, string>; onOpen: (card: Card) => void }) {
  const n = col.tasks.length;
  const live = col.name === 'running' && n > 0;
  const color = NODE_COLOR[col.name];
  return (
    <Box component="section" aria-label={columnLabel(col.name)} data-live={live ? '' : undefined} sx={{ position: 'relative', minWidth: 0, pt: 2.25 }}>
      <Box
        aria-hidden
        sx={{
          position: 'absolute',
          top: -3,
          left: 0,
          width: 7,
          height: 7,
          borderRadius: '50%',
          bgcolor: color ?? ink(0.35),
          ...(live ? { animation: `${pulse} 2.4s ease-out infinite`, '@media (prefers-reduced-motion: reduce)': { animation: 'none' } } : {}),
        }}
      />
      <Stack direction="row" alignItems="baseline" justifyContent="space-between" sx={{ mb: 1.25 }}>
        <Typography component="h3" variant="subtitle2" sx={{ fontWeight: 600 }}>
          {columnLabel(col.name)}
        </Typography>
        <Typography variant="caption" sx={{ fontVariantNumeric: 'tabular-nums', color: n ? 'text.secondary' : 'text.disabled' }}>
          {n}
        </Typography>
      </Stack>
      <Stack spacing={1}>
        {n === 0 ? (
          <Box
            sx={(th) => ({ height: 56, display: 'grid', placeItems: 'center', border: `1px dashed ${alpha(th.palette.text.primary, 0.1)}`, borderRadius: '6px' })}
          >
            <Typography variant="caption" color="text.disabled">
              {t('office.colEmpty')}
            </Typography>
          </Box>
        ) : (
          col.tasks.map((card) => <TaskCard key={card.id} card={card} names={names} onOpen={() => onOpen(card)} />)
        )}
      </Stack>
    </Box>
  );
}

export function Kanban({ seats, canAct, mySeat }: { seats: Seat[]; canAct: boolean; mySeat?: string }) {
  const [params, setParams] = useSearchParams();
  const admin = useIsAdmin(); // 보드 만들기·지금 실행은 관리자만(OMAI-1122). 준비된 카드는 서버가 20초마다 실행한다
  const { openDrawer, drawers } = useUi();
  const { enqueueSnackbar } = useSnackbar();
  const refresh = useRefresh();
  const [folded, setFolded] = useState(readFolded); // 이 브라우저에만 기억한다(계획 2026-10-14-020 §3-4)
  const foldedRef = useRef(folded);
  foldedRef.current = folded;
  const boards = useQuery<{ boards: BoardMeta[] }>({
    queryKey: ['kanban', 'boards'],
    queryFn: () => get(`${K}/boards`),
  });
  const list = boards.data?.boards ?? [];
  const slug =
    params.get('board') && list.some((b) => b.slug === params.get('board'))
      ? (params.get('board') as string)
      : list[0]?.slug;
  const topicQc = useQueryClient();
  // 웹소켓이면 서버가 바뀐 보드를 보낸다(OMAI-1100). 아니면 5초마다 읽는다
  const live = useTopic<BoardView>(slug ? `office:kanban:${slug}` : null, (d) => topicQc.setQueryData(['kanban', 'board', slug], d));
  const view = useQuery<BoardView>({
    queryKey: ['kanban', 'board', slug],
    queryFn: () => get<BoardView>(`${K}/board?board=${encodeURIComponent(slug as string)}`),
    enabled: !!slug,
    refetchInterval: live ? false : 5000,
  });
  // 카드 서랍은 주소 `card=<카드 id>` 와 묶는다(`board` 와 함께, 스펙 2026-10-28-014 §4-4). 열기·닫기·기록·저장 확인은 공용 규칙(useRouteDrawerValue)이다.
  // 보드를 바꾸면 주소를 새로 써서(board 만) card 가 지워지고 서랍이 닫힌다.
  // 머리(제목·상태·담당)는 열 때의 값이므로, 보드가 새로 받아지면(웹소켓 push·5초 읽기) 첫 페이지를 바꾸고(deps)
  // 본문(CardDetail, 별도 조회)도 다시 읽는다 — 다른 사람이 카드를 옮겨도 열어 둔 서랍이 옛 상태로 남지 않는다
  const names = seatNames(seats);
  const cardSpec = (card: Card) => ({
    title: card.title,
    sub: t('office.cardSub', {
      status: columnLabel(card.status),
      assignee: card.assignee ? (names.get(card.assignee) ?? card.assignee) : t('office.cardNoAssigneeShort'),
    }),
    body: <CardDetail slug={slug as string} id={card.id} seats={seats} canAct={canAct} />,
  });
  const cardParam = params.get('card');
  const cardOf = (id: string) => view.data?.columns.flatMap((c) => c.tasks).find((x) => x.id === id);
  const writeCard = useOpenParam('card');
  const patchParams = useParamPatch();
  const cardOpen = drawers.some((d) => d.id === 'route:card');
  // 이 값으로 서랍을 연 적이 있는가. 연 뒤 보드에서 빠진 카드는 지금처럼 서랍을 마지막 머리로 둔다
  const seenCard = useRef<string | null>(null);
  if (!cardParam) seenCard.current = null;
  else if (cardOpen) seenCard.current = cardParam;
  const cardFound = !!cardParam && !!cardOf(cardParam);
  const lastCard = useRef<Card | null>(null);
  useRouteDrawerValue(
    'card',
    slug && view.data && cardParam && (cardFound || seenCard.current === cardParam) ? cardParam : null,
    (id) => {
      const card = cardOf(id) ?? (lastCard.current?.id === id ? lastCard.current : null);
      if (card) lastCard.current = card;
      return card ? cardSpec(card) : { title: id, body: <CardDetail slug={slug as string} id={id} seats={seats} canAct={canAct} /> };
    },
    [],
    [view.data]
  );
  useEffect(() => {
    if (cardParam && cardOpen) void topicQc.invalidateQueries({ queryKey: ['kanban', 'task', slug, cardParam] });
    // 보드 값이 새로 받아질 때만 — 서랍을 바꾸는 것(drawers)에는 반응하지 않는다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [view.data]);
  // 링크의 카드가 이 보드에 없으면(지워짐·다른 보드) 서랍을 열지 않고 알린 뒤 값을 지운다
  const cardMissing = !!slug && !!view.data && !!cardParam && !cardFound && seenCard.current !== cardParam;
  useEffect(() => {
    if (!cardMissing || !cardParam) return;
    enqueueSnackbar(t('office.linkCardMissing', { id: cardParam }), { variant: 'warning' });
    patchParams({ card: null }, { replace: true });
  }, [cardMissing, cardParam, enqueueSnackbar, patchParams]);
  if (!boards.data) return <ScreenLoading title={t('office.kanban')} error={boards.error?.message} />;

  const newBoard = () =>
    openDrawer({ title: t('office.newBoard'), sub: t('office.newBoardSub'), body: <NewBoard /> });
  if (!list.length)
    return (
      <Stack spacing={1.5}>
        <Alert severity="info">
          {t(admin ? 'office.noBoards' : 'office.noBoardsUser')}
        </Alert>
        {canAct && admin && (
          <Box>
            <Button startIcon={<AddIcon />} variant="contained" size="small" onClick={newBoard}>
              {t('office.newBoard')}
            </Button>
          </Box>
        )}
      </Stack>
    );

  const all = (view.data?.columns ?? []).filter((c) => c.name !== 'archived');
  const hidden = all.filter((c) => FOLDED_COLUMNS.includes(c.name));
  const columns = folded ? all.filter((c) => !FOLDED_COLUMNS.includes(c.name)) : all; // 접은 칸은 그리지 않는다(보조기기가 빈 칸을 읽지 않게)
  const toggleFolded = () => {
    writeFolded(!folded);
    setFolded(!folded);
  };
  return (
    <Stack spacing={1.5}>
      <Stack direction="row" spacing={1} alignItems="center" flexWrap="wrap">
        <NativeSelect
          value={slug}
          onChange={(e) => setParams({ tab: 'kanban', board: e.target.value }, { replace: true })}
          inputProps={{ 'aria-label': t('office.boardLabel') }}
        >
          {list.map((b) => (
            <option key={b.slug} value={b.slug}>{`${b.name} (${b.total})`}</option>
          ))}
        </NativeSelect>
        {canAct && (
          <>
            <Button startIcon={<AddIcon />}
              variant="contained"
              size="small"
              onClick={() =>
                openDrawer({
                  id: NEW_CARD_DRAWER,
                  title: t('office.addCard'),
                  sub: boards.data.boards.find((b) => b.slug === slug)?.name,
                  body: <CardForm slug={slug as string} seats={seats} isFolded={() => foldedRef.current} mySeat={mySeat} admin={admin} />,
                })
              }
            >
              {t('office.addCard')}
            </Button>
            {admin && (
            <Button startIcon={<PlayArrowOutlinedIcon />}
              size="small"
              variant="outlined"
              onClick={async () => {
                try {
                  const r = await post<{ spawned: unknown[] }>(
                    `${K}/dispatch?board=${encodeURIComponent(slug as string)}`,
                    {}
                  );
                  enqueueSnackbar(
                    r.spawned.length ? t('office.dispatched', { count: r.spawned.length }) : t('office.dispatchNone'),
                    { variant: 'info' }
                  );
                  await refresh();
                } catch (e) {
                  enqueueSnackbar((e as Error).message, { variant: 'error' });
                }
              }}
            >
              {t('office.dispatchNow')}
            </Button>
            )}
            {admin && (
              <Button startIcon={<AddIcon />} size="small" onClick={newBoard}>
                {t('office.newBoard')}
              </Button>
            )}
          </>
        )}
        <Typography variant="caption" color="text.secondary">
          {t('office.kanbanPushNote')}
        </Typography>
      </Stack>
      {view.error && <Alert severity="error">{view.error.message}</Alert>}
      {/* 카드가 하나도 없는 보드: 무엇을 하면 되는지 한 줄로(OMAI-1286) */}
      {canAct && view.data && all.every((c) => !c.tasks.length) && <Alert severity="info">{t('office.firstCardHint')}</Alert>}
      {hidden.length > 0 && <FoldedStrip hidden={hidden} folded={folded} onToggle={toggleFolded} />}
      <Box
        id={BOARD_ID}
        sx={(th) => ({
          display: 'grid',
          gridAutoFlow: 'column',
          gridAutoColumns: 'minmax(190px, 1fr)', // 다섯 칸이 1360px 화면에서 가로 스크롤 없이 들어가게(5×190+4×16)
          gap: 2,
          overflowX: 'auto',
          pb: 1,
          // 흐름 선: 칸의 점이 매달리는 1px 가로선. 가로로 스크롤해도 같이 움직이게 local 로 붙인다
          backgroundImage: `linear-gradient(${alpha(th.palette.text.primary, 0.1)}, ${alpha(th.palette.text.primary, 0.1)})`,
          backgroundRepeat: 'no-repeat',
          backgroundSize: '100% 1px',
          backgroundAttachment: 'local',
          pt: '3px', // 맨 왼쪽 점이 잘리지 않게
        })}
      >
        {columns.map((col) => (
          <Lane
            key={col.name}
            col={col}
            names={names}
            onOpen={(card) => writeCard({ board: slug, card: card.id })}
          />
        ))}
      </Box>
    </Stack>
  );
}

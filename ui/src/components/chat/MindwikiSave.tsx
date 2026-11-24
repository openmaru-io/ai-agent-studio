/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「MindWiki 에 저장」(스펙 2026-11-15-002 A4·D3·D19, 리뷰 Design 「MindWiki 에 저장」 표).
// 답 아래 행동 줄의 단추. 처음 누르면 저장 위치를 고르고(프로파일마다 서버에 기억), 답을 그대로 새 하위 페이지로 옮긴다(모델 없음).
// 위젯 안에서는 그리지 않는다(D19: 위젯 토큰으로는 저장 경로를 부를 수 없다 — 위젯에서는 에이전트가 MCP 로 쓴다).
// 이유는 코드가 아니라 문장으로(chat.mwSave.reason.<코드>). 같은 저장을 두 번 눌러도 요청 id 가 같아 페이지는 하나다.
// 스펙 2026-11-23-019: 요청 키는 서버가 (대화, 메시지)·(경로, 크기, 수정 시각)으로 만든다(P8, 리뷰 Eng H2). 저장 위치·결과 글자는 행동 줄 맨 끝(S1),
// 툴팁에 저장 위치(S3), 「MindWiki 에서 열기」는 MindWiki 탭 하나를 쓴다(L3b). MindWiki 를 함께 설치하지 않았으면 서버가 hidden 을 준다(G1).
// 고르기 창(스펙 2026-11-23-019 4-6): 실패 경고 → 최근(최근 저장 위치 다섯, R2) → 찾기 → 팀스페이스 목록(한 단계씩 펼침) → 고정 「저장할 곳」 줄과 새로 만들기 →
// 결과 안내 → 제목 → 이 위치 기억. 상태는 useTargetPicker 가 들고 있다. 위치 종류(kind)를 저장·기억 요청에 그대로 보낸다(P8).
// 저장 요청에 위치의 제목·경로·팀스페이스를 함께 보낸다 — 서버가 최근 줄(mindwiki_save_recent)에 남긴다(R2, 「이 위치 기억」과 관계없음).
import AddIcon from '@mui/icons-material/Add';
import CheckIcon from '@mui/icons-material/Check';
import ChevronRightIcon from '@mui/icons-material/ChevronRight';
import ContentCopyOutlinedIcon from '@mui/icons-material/ContentCopyOutlined';
import DescriptionOutlinedIcon from '@mui/icons-material/DescriptionOutlined';
import ErrorOutlineIcon from '@mui/icons-material/ErrorOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import RefreshIcon from '@mui/icons-material/Refresh';
import SaveAltOutlinedIcon from '@mui/icons-material/SaveAltOutlined';
import TableChartOutlinedIcon from '@mui/icons-material/TableChartOutlined';
import WorkspacesOutlinedIcon from '@mui/icons-material/WorkspacesOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  Dialog,
  DialogActions,
  DialogContent,
  DialogTitle,
  FormControlLabel,
  IconButton,
  InputAdornment,
  Link,
  TextField,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { useSnackbar } from 'notistack';
import { type KeyboardEvent, useEffect, useRef, useState } from 'react';

import { useChatTokens } from '@/components/chat/useChatTokens';
import { t } from '@/i18n';
import { chatMetrics } from '@/lib/chatTokens';
import { useMe } from '@/lib/data';
import { useEmbed } from '@/lib/embedContext';

import { useOpenMindwiki } from '../MindwikiLinkButton';
import { call, fromTarget, type PickItem, q, reasonOf, type RecentTarget, type SaveTarget, type TargetKind, toTarget, useTargetPicker, withRecent } from './useTargetPicker';

export type { SaveTarget, TargetKind } from './useTargetPicker';

export interface SaveState {
  available: boolean;
  hidden: boolean;
  reason: string;
  target: SaveTarget | null;
  /** 최근 저장한 위치(새것 먼저, 지금 연결 워크스페이스만). 옛 서버는 없다 */
  recent?: RecentTarget[];
}

/** 서버가 준 이유 코드를 문장으로. 모르는 코드는 「저장하지 못했습니다」 */
export const reasonText = (reason: string): string => {
  const key = `chat.mwSave.reason.${reason}`;
  const s = t(key);
  return s === key ? t('chat.mwSave.reason.invalid') : s;
};

/** 답의 첫 제목 줄, 없으면 「<에이전트> 답 <날짜>」 */
export function defaultTitle(markdown: string, agent: string, now = new Date()): string {
  const h = /^\s{0,3}#{1,6}\s+(.+?)\s*#*\s*$/m.exec(markdown)?.[1];
  if (h) return h.slice(0, 200);
  const d = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  return t('chat.mwSave.defaultTitle', { agent, date: d });
}

/** 긴 경로는 가운데를 줄인다: 「팀스페이스 › … › 마지막 페이지」(스펙 2026-11-23-019 S1, Design D8) */
export function shortPath(parts: string[]): string {
  const p = parts.filter(Boolean);
  return p.length > 3 ? [p[0], '…', p[p.length - 1]].join(' › ') : p.join(' › ');
}
const targetPath = (t: SaveTarget) => [t.path, t.parent_title].filter(Boolean).join(' › ');

/** MindWiki 가 준 주소의 경로에 브라우저용 MindWiki 출처를 붙인다 — WIKI_PUBLIC_URL 이 없으면 요청 Host(클러스터 안 주소)로 온다(L3b) */
export function browserUrl(url: string, mindwikiUrl: string): string {
  if (!url || !mindwikiUrl) return url;
  try {
    const u = new URL(url, mindwikiUrl);
    return new URL(u.pathname + u.search + u.hash, mindwikiUrl).toString();
  } catch {
    return url;
  }
}

const stateCache = new Map<string, Promise<SaveState>>();
/** 프로파일마다 한 번 읽는다(저장 위치를 바꾸면 지운다) */
export function loadSaveState(pod: string, profile: string): Promise<SaveState> {
  const k = `${pod}\n${profile}`;
  let p = stateCache.get(k);
  if (!p) {
    p = call<SaveState>('GET', `/api/mindwiki/save/state?${q({ pod, profile })}`).catch(() => ({ available: false, hidden: true, reason: 'invalid', target: null }));
    stateCache.set(k, p);
  }
  return p;
}
export const forgetSaveState = (pod?: string, profile?: string) => {
  if (pod === undefined) stateCache.clear();
  else stateCache.delete(`${pod}\n${profile}`);
};

/** 저장이 이 이유로 실패하면 고르기 창을 연다. 앞의 셋은 창 맨 위에 경고 줄로 이유를 보인다(4-6 Design D4) */
const ALERT_REASONS = new Set(['parent_not_found', 'forbidden_parent', 'row_rejected']);
const REPICK_REASONS = new Set([...ALERT_REASONS, 'need_target']);
/** 서버가 기억 위치를 지운 이유(R3). row_rejected 는 데이터베이스가 그대로라 지우지 않는다(P6) */
const GONE_REASONS = new Set(['parent_not_found', 'forbidden_parent']);

/** 실패로 고르기 창을 열 때 넘기는 값 */
interface Repick {
  reason: string;
  /** row_rejected 를 낸 데이터베이스 — 최근·목록에서 막는다 */
  rejectedId: string;
}

/** 위치의 제목·경로·팀스페이스 — 서버가 최근 줄에 남긴다(R2). 경로는 parent_path(파일 저장의 path 는 파일 경로다) */
const placeOf = (t: SaveTarget) => ({ parent_id: t.parent_id, kind: t.kind ?? 'page', parent_title: t.parent_title, parent_path: t.path, teamspace: t.teamspace });

/** 저장 성공 뒤: 최근 목록 맨 앞에 넣는다. 다른 답의 단추가 새로 그려질 때 서버 값을 다시 읽게 기억도 지운다 */
function afterSave(target: SaveTarget, pod: string, profile: string, setState: (f: (s: SaveState | null) => SaveState | null) => void) {
  forgetSaveState(pod, profile);
  setState((s) => (s ? { ...s, recent: withRecent(s.recent, target) } : s));
}

/** 저장 실패 뒤: 기억 위치와 그 최근 줄을 화면에서도 지우고(서버는 이미 지웠다, R3), 다시 고를지 정한다 */
function afterFail(reason: string, target: SaveTarget, pod: string, profile: string, state: SaveState, setState: (s: SaveState) => void): Repick | null {
  if (GONE_REASONS.has(reason)) {
    forgetSaveState(pod, profile);
    setState({
      ...state,
      target: state.target?.parent_id === target.parent_id ? null : state.target,
      recent: state.recent?.filter((r) => r.parent_id !== target.parent_id),
    });
  }
  if (!REPICK_REASONS.has(reason)) return null;
  return { reason, rejectedId: reason === 'row_rejected' ? target.parent_id : '' };
}

type Phase =
  | { kind: 'idle' }
  | { kind: 'saving' }
  | { kind: 'saved'; title: string; url: string }
  /** 행은 만들었지만 본문을 쓰지 못함(W2 bodyFailed) — 같은 키라 다시 눌러도 채워지지 않는다(P8) */
  | { kind: 'partial'; title: string; url: string }
  | { kind: 'failed'; reason: string };

export function SaveToMindwiki({
  pod,
  profile,
  conversation,
  message,
  markdown,
  agent,
  latest = true,
}: {
  pod: string;
  profile: string;
  conversation: string;
  message: string;
  markdown: string;
  agent: string;
  /** 마지막 답인가 — 「저장 위치」 글자는 마지막 답에만 보인다(모든 답에 같은 경로가 되풀이되지 않게, Design D8) */
  latest?: boolean;
}) {
  const embed = useEmbed();
  const mindwikiUrl = useMe().data?.mindwiki_url ?? '';
  const openMindwiki = useOpenMindwiki();
  const tk = useChatTokens();
  const [state, setState] = useState<SaveState | null>(null);
  const [phase, setPhase] = useState<Phase>({ kind: 'idle' });
  const [picking, setPicking] = useState<Repick | null>(null);
  const [copied, setCopied] = useState(false);
  useEffect(() => {
    if (embed || !pod || !profile) return;
    let live = true;
    void loadSaveState(pod, profile).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [embed, pod, profile]);
  if (embed || !state || state.hidden) return null;

  const save = async (target: SaveTarget, title: string, now: SaveState) => {
    setPhase({ kind: 'saving' });
    try {
      const out = await call<{ url: string; body_failed?: boolean }>('POST', '/api/mindwiki/save/answer', {
        pod,
        profile,
        conversation,
        message,
        ...placeOf(target),
        title,
        markdown,
        agent,
      });
      setPhase({ kind: out.body_failed ? 'partial' : 'saved', title, url: out.url });
      afterSave(target, pod, profile, setState);
    } catch (e) {
      const reason = reasonOf(e);
      setPhase({ kind: 'failed', reason });
      const again = afterFail(reason, target, pod, profile, now, setState);
      if (again) setPicking(again); // 위치를 다시 고른다
    }
  };
  const press = () => (state.target ? void save(state.target, defaultTitle(markdown, agent), state) : setPicking({ reason: '', rejectedId: '' }));
  const copyBody = async () => {
    try {
      await navigator.clipboard.writeText(markdown);
      setCopied(true);
      window.setTimeout(() => setCopied(false), 1500);
    } catch {
      /* 복사하지 못하면 글자가 바뀌지 않아 알 수 있다 */
    }
  };
  const blocked = !state.available;
  const label = blocked
    ? reasonText(state.reason)
    : state.target
      ? t('chat.mwSave.tooltipTarget', { path: shortPath(targetPath(state.target).split(' › ')) })
      : t('chat.mwSave.tooltipPick');
  const btnSx = { color: tk.muted, '&:hover': { color: tk.text }, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };
  const openLink = (url: string) =>
    url && (
      <Link component="button" type="button" onClick={() => void openMindwiki(browserUrl(url, mindwikiUrl), { navigate: true })} sx={{ fontSize: 12, verticalAlign: 'baseline' }} data-testid="mw-open">
        {t('chat.mwSave.open')}
      </Link>
    );
  return (
    <>
      <Tooltip title={label}>
        <span>
          <IconButton size="small" aria-label={t('chat.mwSave.button')} aria-busy={phase.kind === 'saving'} disabled={blocked || phase.kind === 'saving'} data-testid="mw-save" onClick={press} sx={btnSx}>
            {phase.kind === 'saving' ? <CircularProgress size={14} /> : phase.kind === 'saved' ? <CheckIcon sx={{ fontSize: 16 }} /> : <SaveAltOutlinedIcon sx={{ fontSize: 16 }} />}
          </IconButton>
        </span>
      </Tooltip>
      {/* 글자는 단추 사이가 아니라 행동 줄 맨 끝(order), 좁은 화면에서는 자기 줄(S1·Design D8). 부분 결과는 길어 늘 자기 줄 */}
      <Box
        component="span"
        aria-live="polite"
        sx={{
          order: 99,
          display: 'inline-flex',
          alignItems: 'center',
          gap: 0.75,
          fontSize: 12,
          color: tk.muted,
          minWidth: 0,
          ...(phase.kind === 'partial' ? { flexBasis: '100%' } : {}),
          '@media (max-width: 599.95px)': { flexBasis: '100%' },
        }}
      >
        {phase.kind === 'saved' && (
          <span data-testid="mw-saved">
            {t('chat.mwSave.saved', { title: phase.title })} {openLink(phase.url)}
          </span>
        )}
        {phase.kind === 'partial' && (
          <span data-testid="mw-partial">
            <Box component="span" sx={{ color: tk.warn }}>
              {t('chat.mwSave.bodyFailed')}
            </Box>{' '}
            <Button size="small" color="inherit" startIcon={<ContentCopyOutlinedIcon sx={{ fontSize: 14 }} />} onClick={() => void copyBody()} sx={{ fontSize: 12, py: 0, minHeight: 0 }} data-testid="mw-copy-body">
              {copied ? t('chat.copiedLive') : t('chat.mwSave.copyBody')}
            </Button>{' '}
            {openLink(phase.url)}
            <Box component="span" sx={{ display: 'block' }}>
              {t('chat.mwSave.bodyFailedNote')}
            </Box>
          </span>
        )}
        {phase.kind === 'failed' && <span data-testid="mw-failed">{reasonText(phase.reason)}</span>}
        {phase.kind === 'idle' && state.target && !blocked && latest && (
          <span data-testid="mw-target">
            {t('chat.mwSave.target', { path: shortPath(targetPath(state.target).split(' › ')) })} ·{' '}
            <Link component="button" type="button" onClick={() => setPicking({ reason: '', rejectedId: '' })} sx={{ fontSize: 12, verticalAlign: 'baseline' }}>
              {t('chat.mwSave.change')}
            </Link>
          </span>
        )}
      </Box>
      {picking && (
        <TargetDialog
          pod={pod}
          profile={profile}
          initialTitle={defaultTitle(markdown, agent)}
          remembered={state.target}
          recent={state.recent}
          failReason={picking.reason}
          rejectedId={picking.rejectedId}
          onClose={() => setPicking(null)}
          onPicked={(target, title, remember) => {
            setPicking(null);
            const now = remember ? { ...state, target } : state;
            if (remember) setState(now);
            void save(target, title, now);
          }}
        />
      )}
    </>
  );
}

const KIND_ICON: Record<TargetKind, typeof DescriptionOutlinedIcon> = {
  page: DescriptionOutlinedIcon,
  database: TableChartOutlinedIcon,
  teamspace: WorkspacesOutlinedIcon,
};

const itemPath = (it: PickItem) => (it.kind === 'teamspace' ? [it.title] : [...it.path.split(' › '), it.title]);
const same = (a: PickItem | null, b: PickItem) => !!a && a.id === b.id && a.kind === b.kind;

/** 저장 위치 고르기(스펙 2026-11-23-019 4-4·4-6). 상태는 useTargetPicker, 여기서는 그리기와 키보드(WAI-ARIA tree)만 */
export function TargetDialog({
  pod,
  profile,
  initialTitle,
  noTitle,
  remembered = null,
  recent: recentList,
  failReason = '',
  rejectedId = '',
  onClose,
  onPicked,
}: {
  pod: string;
  profile: string;
  initialTitle: string;
  /** 파일 저장 — 제목 칸이 없다 */
  noTitle?: boolean;
  /** 기억한 위치 — 「최근」 칸의 같은 줄에 「기억한 위치」 표시(순서와 관계없음). 최근에 없으면 맨 앞 줄로 더한다 */
  remembered?: SaveTarget | null;
  /** 최근 저장한 위치(새것 먼저, R2) */
  recent?: RecentTarget[];
  /** 저장이 실패해 저절로 열렸을 때의 이유 */
  failReason?: string;
  rejectedId?: string;
  onClose: () => void;
  onPicked: (t: SaveTarget, title: string, remember: boolean) => void;
}) {
  const p = useTargetPicker(pod, profile);
  const tk = useChatTokens();
  const theme = useTheme();
  const fullScreen = useMediaQuery(theme.breakpoints.down('sm'));
  const [title, setTitle] = useState(initialTitle);
  const [remember, setRemember] = useState(true);
  const [error, setError] = useState('');
  const [focusKey, setFocusKey] = useState('');
  const refs = useRef(new Map<string, HTMLElement>());
  const nameRef = useRef<HTMLInputElement>(null);
  const creating = p.create?.make;
  useEffect(() => {
    if (creating) nameRef.current?.focus(); // 새로 만들기를 누르면 이름 칸으로
  }, [creating]);
  const sel = p.selected;
  const canMake = p.saveLevel >= 2;

  /** 막힌 이유(툴팁 글자). 빈 값이면 막히지 않았다 */
  const blockOf = (it: PickItem, recent = false): string => {
    if (rejectedId && it.id === rejectedId) return t('chat.mwSave.blockedRow');
    if (it.kind === 'teamspace' && !recent) return canMake && !it.canCreateTop ? t('chat.mwSave.blockedTop') : '';
    if (it.kind !== 'page' && p.teamspaces && !canMake) return reasonText('need_upgrade');
    return '';
  };
  /** 판이 섞인 설치(save_level < 2)에서 팀스페이스 줄은 펼치기만 된다(P7) */
  const selectable = (it: PickItem, recent = false) => !(it.kind === 'teamspace' && !recent && !canMake) && !blockOf(it, recent);

  const items = p.rows.flatMap((r) => (r.type === 'item' ? [r] : []));
  const tabKey = items.some((r) => r.item.key === focusKey) ? focusKey : (items.find((r) => same(sel, r.item)) ?? items[0])?.item.key;
  const move = (key: string | undefined) => {
    if (!key) return;
    setFocusKey(key);
    refs.current.get(key)?.focus();
  };
  const onTreeKey = (e: KeyboardEvent<HTMLElement>) => {
    const key = (e.target as HTMLElement).closest('[role="treeitem"]')?.getAttribute('data-key');
    const i = items.findIndex((r) => r.item.key === key);
    if (i < 0) return;
    const r = items[i];
    const handled = () => e.preventDefault();
    switch (e.key) {
      case 'ArrowDown':
        handled();
        move(items[i + 1]?.item.key);
        break;
      case 'ArrowUp':
        handled();
        move(items[i - 1]?.item.key);
        break;
      case 'Home':
        handled();
        move(items[0]?.item.key);
        break;
      case 'End':
        handled();
        move(items[items.length - 1]?.item.key);
        break;
      case 'ArrowRight':
        handled();
        if (r.expandable && !r.expanded) p.expand(r.item);
        else if (r.expanded && items[i + 1]?.parentKey === r.item.key) move(items[i + 1].item.key);
        break;
      case 'ArrowLeft':
        handled();
        if (r.expanded) p.collapse(r.item);
        else if (r.parentKey) move(r.parentKey);
        break;
      case 'Enter':
      case ' ':
        handled();
        if (selectable(r.item)) p.select(r.item);
        else if (r.expandable) p.toggle(r.item);
        break;
    }
  };

  const confirm = async () => {
    if (!sel) return;
    const target = toTarget(sel);
    if (remember) {
      try {
        await call('PUT', '/api/mindwiki/save/target', { pod, profile, ...target });
        forgetSaveState(pod, profile);
      } catch (e) {
        setError(reasonText(reasonOf(e)));
        return;
      }
    }
    onPicked(target, title.trim() || initialTitle, remember);
  };

  const rowSx = (on: boolean, blocked: boolean) => ({
    display: 'flex',
    alignItems: 'center',
    gap: 0.75,
    minHeight: 36,
    pr: 1,
    cursor: blocked ? 'default' : 'pointer',
    color: blocked ? tk.muted : tk.text,
    fontSize: 13,
    outline: 'none',
    // 고른 줄: 무채색 wash + 왼쪽 선 + 체크 아이콘(DESIGN.md §1-1.2, 색에만 기대지 않음)
    ...(on ? { bgcolor: tk.selected, boxShadow: `inset 2px 0 0 ${tk.selectedAccent}` } : {}),
    '&:hover': on ? {} : { bgcolor: tk.hover },
    '&:focus-visible': { boxShadow: `inset 0 0 0 2px ${tk.selectedAccent}` },
    '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
  });
  const kindIcon = (k: TargetKind) => {
    const Icon = KIND_ICON[k];
    return <Icon sx={{ fontSize: 16, color: tk.muted, flex: 'none' }} titleAccess={t(`chat.mwSave.kind.${k}`)} />;
  };
  const note = (text: string) => <Typography sx={{ px: 1.5, py: 1, fontSize: 13, color: tk.muted }}>{text}</Typography>;

  // 최근: 저장한 시각 순서 그대로. 「기억한 위치」 표시는 기억한 위치와 같은 줄에만(순서와 관계없음, 4-6 D12·D13).
  // 기억한 위치가 최근에 없으면(옛 서버·다섯 밖으로 밀림) 맨 앞 줄로 더한다
  const recentRows: PickItem[] = [];
  for (const r of recentList ?? []) if (r.parent_id && !recentRows.some((x) => x.id === r.parent_id)) recentRows.push(fromTarget(r));
  if (remembered && !recentRows.some((x) => x.id === remembered.parent_id)) recentRows.unshift(fromTarget(remembered));
  const resultText = !sel
    ? ''
    : noTitle
      ? t(sel.kind === 'database' ? 'chat.mwSave.result.fileDatabase' : 'chat.mwSave.result.filePage')
      : t(`chat.mwSave.result.${sel.kind}`);
  const c = p.create;

  return (
    <Dialog open onClose={onClose} fullWidth maxWidth="sm" fullScreen={fullScreen} aria-labelledby="mw-pick-title">
      <DialogTitle id="mw-pick-title">{t('chat.mwSave.pickTitle')}</DialogTitle>
      <DialogContent sx={{ display: 'flex', flexDirection: 'column', gap: 1.5, pt: '8px !important' }}>
        {ALERT_REASONS.has(failReason) && (
          <Alert severity="warning" data-testid="mw-fail-alert">
            {reasonText(failReason)}
          </Alert>
        )}
        {error && <Alert severity="warning">{error}</Alert>}
        {recentRows.length > 0 && (
          <Box data-testid="mw-recent" role="group" aria-labelledby="mw-recent-title">
            <Typography id="mw-recent-title" component="h3" sx={{ fontSize: 12, fontWeight: 600, color: tk.muted, mb: 0.5 }}>
              {t('chat.mwSave.recent')}
            </Typography>
            {recentRows.map((it) => {
              const block = blockOf(it, true);
              const can = selectable(it, true);
              const on = same(sel, it);
              const mine = !!remembered && it.id === remembered.parent_id;
              return (
                <Tooltip key={it.key} title={block} describeChild>
                  <Box
                    role="button"
                    tabIndex={block ? -1 : 0}
                    aria-disabled={!!block || undefined}
                    aria-pressed={on}
                    data-testid="mw-recent-item"
                    data-id={it.id}
                    data-remembered={mine || undefined}
                    onClick={() => can && p.select(it)}
                    onKeyDown={(e) => {
                      if ((e.key === 'Enter' || e.key === ' ') && can) {
                        e.preventDefault();
                        p.select(it);
                      }
                    }}
                    sx={{ ...rowSx(on, !!block), pl: 1, borderRadius: 1 }}
                  >
                    {kindIcon(it.kind)}
                    <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                      {shortPath(itemPath(it))}
                    </Box>
                    {mine && (
                      <Box component="span" sx={{ fontSize: 11, color: tk.muted, flex: 'none' }} data-testid="mw-remembered">
                        · {t('chat.mwSave.remembered')}
                      </Box>
                    )}
                    {on && <CheckIcon sx={{ fontSize: 16, flex: 'none' }} />}
                  </Box>
                </Tooltip>
              );
            })}
          </Box>
        )}
        <TextField
          size="small"
          label={canMake ? t('chat.mwSave.searchAll') : t('chat.mwSave.search')}
          value={p.query}
          onChange={(e) => p.setQuery(e.target.value)}
          InputProps={{ endAdornment: p.searching ? <InputAdornment position="end"><CircularProgress size={14} aria-label={t('chat.mwSave.loading')} /></InputAdornment> : undefined }}
          inputProps={{ 'data-testid': 'mw-search' }}
        />
        {p.searchActive && p.searchReason && <Alert severity="warning">{reasonText(p.searchReason)}</Alert>}
        {p.tsReason && !p.searchActive && (
          <Alert
            severity="warning"
            action={
              <Button color="inherit" size="small" startIcon={<RefreshIcon />} onClick={p.reloadTeamspaces}>
                {t('chat.mwSave.retry')}
              </Button>
            }
          >
            {reasonText(p.tsReason)}
          </Alert>
        )}
        <Box
          role="tree"
          aria-label={t('chat.mwSave.treeLabel')}
          onKeyDown={onTreeKey}
          data-testid="mw-tree"
          sx={{ flex: '1 1 auto', minHeight: 120, maxHeight: fullScreen ? 'none' : 300, overflowY: 'auto', border: 1, borderColor: 'divider', borderRadius: 1, py: 0.5 }}
        >
          {!p.searchActive && p.teamspaces === null && !p.tsReason && note(t('chat.mwSave.loading'))}
          {!p.searchActive && p.teamspaces?.length === 0 && note(t('chat.mwSave.noTeamspace'))}
          {p.searchActive && !p.searching && !p.searchReason && items.length === 0 && note(t('chat.mwSave.noMatch'))}
          {p.rows.map((r) => {
            if (r.type !== 'item') {
              const pad = { pl: 1 + r.level * 2.5 };
              return (
                <Box key={r.key} role="none" sx={{ ...pad, py: 0.75, fontSize: 12, color: tk.muted }} data-testid={`mw-row-${r.type}`}>
                  {r.type === 'failed' ? (
                    <>
                      {t('chat.mwSave.loadFailed')} ·{' '}
                      <Link component="button" type="button" onClick={() => p.retry(r.parentKey)} sx={{ fontSize: 12, verticalAlign: 'baseline' }}>
                        {t('chat.mwSave.retry')}
                      </Link>
                    </>
                  ) : r.type === 'empty' ? (
                    r.teamspaceLevel ? t('chat.mwSave.noPage') : t('chat.mwSave.noChild')
                  ) : (
                    t('chat.mwSave.more')
                  )}
                </Box>
              );
            }
            const it = r.item;
            const blocked = blockOf(it);
            const can = selectable(it);
            const on = can && same(sel, it);
            return (
              <Tooltip key={it.key} title={blocked} placement="top-start" describeChild>
                <Box
                  role="treeitem"
                  data-key={it.key}
                  data-testid={it.kind === 'teamspace' ? 'mw-ts' : 'mw-page'}
                  aria-level={r.level}
                  aria-expanded={r.expandable ? r.expanded : undefined}
                  aria-selected={can ? on : undefined}
                  aria-disabled={blocked ? true : undefined}
                  aria-busy={r.loading || undefined}
                  tabIndex={it.key === tabKey ? 0 : -1}
                  ref={(el: HTMLElement | null) => {
                    if (el) refs.current.set(it.key, el);
                    else refs.current.delete(it.key);
                  }}
                  onFocus={() => setFocusKey(it.key)}
                  onClick={() => (can ? p.select(it) : r.expandable && p.toggle(it))}
                  sx={{ ...rowSx(on, !!blocked), pl: 0.5 + (r.level - 1) * 2.5 }}
                >
                  {r.expandable ? (
                    <IconButton
                      size="small"
                      tabIndex={-1}
                      aria-label={r.expanded ? t('chat.mwSave.collapse') : t('chat.mwSave.expand')}
                      onClick={(e) => {
                        e.stopPropagation();
                        p.toggle(it);
                      }}
                      sx={{ p: 0.25, color: tk.muted }}
                    >
                      {r.loading ? <CircularProgress size={14} /> : r.expanded ? <ExpandMoreIcon sx={{ fontSize: 18 }} /> : <ChevronRightIcon sx={{ fontSize: 18 }} />}
                    </IconButton>
                  ) : (
                    <Box component="span" sx={{ width: 26, flex: 'none' }} />
                  )}
                  {kindIcon(it.kind)}
                  <Box component="span" sx={{ flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {it.title}
                    {p.searchActive && it.path && (
                      <Box component="span" sx={{ ml: 1, fontSize: 12, color: tk.muted }}>
                        {shortPath(it.path.split(' › '))}
                      </Box>
                    )}
                  </Box>
                  {on && <CheckIcon sx={{ fontSize: 16, flex: 'none' }} />}
                </Box>
              </Tooltip>
            );
          })}
        </Box>
      </DialogContent>
      {/* 「저장할 곳」 줄부터는 목록이 길어도 아래에 붙박는다(4-6) */}
      <Box sx={{ px: 3, pt: 1.5, display: 'flex', flexDirection: 'column', gap: 1, borderTop: 1, borderColor: 'divider' }}>
        {c ? (
          <Box>
            <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
              <TextField
                size="small"
                inputRef={nameRef}
                label={c.make === 'page' ? t('chat.mwSave.newPageName') : t('chat.mwSave.newDatabaseName')}
                value={c.name}
                disabled={c.busy}
                onChange={(e) => p.setCreateName(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === 'Enter') {
                    e.preventDefault();
                    void p.submitCreate();
                  }
                }}
                inputProps={{ maxLength: 200, 'data-testid': 'mw-new-name' }}
                sx={{ flex: '1 1 200px' }}
              />
              <Button variant="outlined" color="inherit" disabled={!c.name.trim() || c.busy} onClick={() => void p.submitCreate()} aria-busy={c.busy} data-testid="mw-make" startIcon={c.busy ? <CircularProgress size={14} /> : undefined}>
                {t('chat.mwSave.make')}
              </Button>
              <Button color="inherit" disabled={c.busy} onClick={p.cancelCreate}>
                {t('chat.mwSave.cancel')}
              </Button>
            </Box>
            {c.reason && (
              <Typography role="alert" sx={{ mt: 0.5, fontSize: 12, color: tk.warn }} data-testid="mw-make-failed">
                {c.unknown ? t('chat.mwSave.createUnknown') : reasonText(c.reason)}
                {c.unknown && (
                  <>
                    {' '}
                    <Link component="button" type="button" onClick={() => void p.submitCreate(true)} sx={{ fontSize: 12, verticalAlign: 'baseline' }} data-testid="mw-make-retry">
                      {t('chat.mwSave.retry')}
                    </Link>
                  </>
                )}
              </Typography>
            )}
          </Box>
        ) : (
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 1, flexWrap: 'wrap' }}>
            <Typography data-testid="mw-dest" title={sel ? itemPath(sel).filter(Boolean).join(' › ') : undefined} noWrap sx={{ flex: '1 1 200px', minWidth: 0, fontSize: 13, color: sel ? tk.text : tk.muted }}>
              {sel ? t('chat.mwSave.dest', { path: shortPath(itemPath(sel)) }) : t('chat.mwSave.pickPrompt')}
            </Typography>
            {canMake && (
              <Button size="small" color="inherit" startIcon={<AddIcon />} disabled={!sel || sel.kind === 'database'} onClick={() => p.startCreate('page')} data-testid="mw-new-page">
                {t('chat.mwSave.newPage')}
              </Button>
            )}
            {canMake && p.makeDatabase && (
              <Button size="small" color="inherit" startIcon={<AddIcon />} disabled={!sel || sel.kind === 'database'} onClick={() => p.startCreate('database')} data-testid="mw-new-db">
                {t('chat.mwSave.newDatabase')}
              </Button>
            )}
          </Box>
        )}
        {resultText && (
          <Typography sx={{ fontSize: 12, color: tk.muted }} data-testid="mw-result">
            {resultText}
          </Typography>
        )}
        {!noTitle && (
          <TextField
            size="small"
            label={sel?.kind === 'database' ? t('chat.mwSave.rowTitle') : t('chat.mwSave.pageTitle')}
            value={title}
            onChange={(e) => setTitle(e.target.value)}
            inputProps={{ maxLength: 200 }}
          />
        )}
        <FormControlLabel control={<Checkbox checked={remember} onChange={(e) => setRemember(e.target.checked)} />} label={t('chat.mwSave.remember')} />
      </Box>
      <DialogActions>
        <Button onClick={onClose} color="inherit">
          {t('chat.mwSave.cancel')}
        </Button>
        <Button variant="contained" disabled={!sel || !selectable(sel, sel.key.startsWith('recent:')) || (!noTitle && !title.trim()) || !!c?.busy} onClick={() => void confirm()} data-testid="mw-pick-save">
          {t('chat.mwSave.save')}
        </Button>
      </DialogActions>
    </Dialog>
  );
}

/** 「파일」 서랍의 파일 하나를 그 위치의 「AAS 파일」 페이지(데이터베이스면 새 행)에 첨부한다(A4). 크기 한도는 MindWiki 첨부 한도(파일은 흘려 보낸다) */
export function SaveFileToMindwiki({ pod, profile, path, name, sx }: { pod: string; profile: string; path: string; name: string; sx?: object }) {
  const embed = useEmbed();
  const { enqueueSnackbar, closeSnackbar } = useSnackbar();
  const mindwikiUrl = useMe().data?.mindwiki_url ?? '';
  const openMindwiki = useOpenMindwiki();
  const [done, setDone] = useState<'saved' | 'failed' | null>(null);
  const [state, setState] = useState<SaveState | null>(null);
  const [busy, setBusy] = useState(false);
  const [picking, setPicking] = useState<Repick | null>(null);
  useEffect(() => {
    if (embed || !pod || !profile) return;
    let live = true;
    void loadSaveState(pod, profile).then((s) => live && setState(s));
    return () => {
      live = false;
    };
  }, [embed, pod, profile]);
  if (embed || !state || state.hidden) return null;
  const openAction = (url: string) =>
    url
      ? (id: string | number) => (
          <Button
            size="small"
            color="inherit"
            onClick={() => {
              closeSnackbar(id);
              void openMindwiki(browserUrl(url, mindwikiUrl), { navigate: true });
            }}
          >
            {t('chat.mwSave.open')}
          </Button>
        )
      : undefined;
  const save = async (target: SaveTarget, now: SaveState) => {
    setBusy(true);
    try {
      const out = await call<{ url: string; name: string; attach_failed?: boolean }>('POST', '/api/mindwiki/save/file', { pod, profile, path, ...placeOf(target) });
      afterSave(target, pod, profile, setState); // 첨부가 실패해도 행은 생겼다 — 위치는 그대로 쓸 수 있다
      if (out.attach_failed) {
        // 데이터베이스에 행은 만들었지만 첨부가 실패했다(리뷰 Eng W4) — 행 주소로 열 수 있게 한다
        setDone('failed');
        enqueueSnackbar(t('chat.mwSave.attachFailed', { title: out.name || name }), { variant: 'warning', action: openAction(out.url) });
        return;
      }
      setDone('saved');
      // 파일 저장 알림에도 「MindWiki 에서 열기」(Design D9) — 답 저장과 같은 결과 모양
      enqueueSnackbar(t('chat.mwSave.saved', { title: out.name || name }), { variant: 'success', action: openAction(out.url) });
    } catch (e) {
      const reason = reasonOf(e);
      setDone('failed');
      enqueueSnackbar(reasonText(reason), { variant: 'warning' });
      const again = afterFail(reason, target, pod, profile, now, setState);
      if (again) setPicking(again);
    } finally {
      setBusy(false);
    }
  };
  const blocked = !state.available;
  return (
    <>
      <Tooltip
        title={
          blocked
            ? reasonText(state.reason)
            : state.target
              ? t('chat.mwSave.tooltipTarget', { path: shortPath(targetPath(state.target).split(' › ')) })
              : t('chat.mwSave.tooltipPick')
        }
      >
        <span>
          <IconButton
            aria-label={`${t('chat.mwSave.button')}: ${name}`}
            aria-busy={busy}
            disabled={blocked || busy}
            data-testid="mw-save-file"
            onClick={() => (state.target ? void save(state.target, state) : setPicking({ reason: '', rejectedId: '' }))}
            sx={sx}
          >
            {busy ? (
              <CircularProgress size={14} />
            ) : done === 'saved' ? (
              <CheckIcon sx={{ fontSize: 16 }} />
            ) : done === 'failed' ? (
              <ErrorOutlineIcon sx={{ fontSize: 16 }} />
            ) : (
              <SaveAltOutlinedIcon sx={{ fontSize: 16 }} />
            )}
          </IconButton>
        </span>
      </Tooltip>
      {picking && (
        <TargetDialog
          pod={pod}
          profile={profile}
          initialTitle={name}
          noTitle
          remembered={state.target}
          recent={state.recent}
          failReason={picking.reason}
          rejectedId={picking.rejectedId}
          onClose={() => setPicking(null)}
          onPicked={(target, _title, remember) => {
            setPicking(null);
            const now = remember ? { ...state, target } : state;
            if (remember) setState(now);
            void save(target, now);
          }}
        />
      )}
    </>
  );
}

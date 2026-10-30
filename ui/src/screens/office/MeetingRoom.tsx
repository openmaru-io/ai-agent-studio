/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 회의 방 하나의 대화. 말을 올리면 참가한 에이전트(설치본이 달라도)가 각자 답한다.
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import EditOutlinedIcon from '@mui/icons-material/EditOutlined';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import InfoOutlinedIcon from '@mui/icons-material/InfoOutlined';
import LockOutlinedIcon from '@mui/icons-material/LockOutlined';
import RefreshIcon from '@mui/icons-material/Refresh';
import SummarizeOutlinedIcon from '@mui/icons-material/SummarizeOutlined';
import WarningAmberRoundedIcon from '@mui/icons-material/WarningAmberRounded';
import type { SxProps, Theme } from '@mui/material';
import { Box, Button, Divider, IconButton, LinearProgress, Link as MuiLink, Stack, Tooltip, Typography, useMediaQuery, useTheme } from '@mui/material';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Fragment, ReactNode, useEffect, useRef, useState } from 'react';
import { useNavigate } from 'react-router-dom';

import { AgentDot } from '@/components/AgentChip';
import { Tag } from '@/components/bits';
import { Composer, ComposerHandle } from '@/components/chat/Composer';
import { CopyButton } from '@/components/chat/CopyButton';
import { ErrorRow } from '@/components/chat/ErrorRow';
import { LostReplyRow } from '@/components/chat/LostReplyRow';
import { MessageRow } from '@/components/chat/MessageRow';
import { ReadAloudButton, readPinned, ReadTarget, useReadScope, useReadSnap } from '@/components/chat/ReadAloud';
import { ReconnectRow } from '@/components/chat/ReconnectRow';
import { missingFor, skillSource, skillSuggestItems } from '@/components/chat/skillSuggest';
import { TypingDots } from '@/components/chat/TypingDots';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { useMyVoice } from '@/components/chat/VoiceInput';
import { useConfirm } from '@/components/ConfirmDialog';
import { ItemEmpty, ItemList, ItemRow } from '@/components/ItemRow';
import { Markdown } from '@/components/Markdown';
import { tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { useMeetingPlace } from '@/features/office/meetings';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { backoffDelay, RETRY_MAX_MS } from '@/lib/backoff';
import { humanSize } from '@/lib/chatFiles';
import { chatColumn, chatMetrics, chatType, hueOf } from '@/lib/chatTokens';
import { afterLeadingMentions, findMentions, leadingCommand, SuggestItem } from '@/lib/composerSuggest';
import { useMe } from '@/lib/data';
import { fmtTs } from '@/lib/format';
import { groupMeeting } from '@/lib/groupMeeting';
import { blockedLast, GUARD_KIND, guardGroups, isGuardBlocked } from '@/lib/meetingGuard';
import { switchPod } from '@/lib/pod';
import { briefSummary } from '@/lib/roomBrief';
import { closeRoomChat } from '@/lib/roomChatPopup';
import { FOCUS_RING } from '@/lib/shellTokens';
import { useSkillSuggest } from '@/lib/useSkillSuggest';
import { useConnWait, useTopic } from '@/lib/ws';
import { AgentAvatar } from '@/screens/chat/parts';
import {
  AgentFilesData,
  AgentFilesRow,
  AttachButton,
  AttachData,
  AttachFoot,
  DropOverlay,
  fileErrorText,
  FilesInfo,
  MeetingFilesDrawer,
  SkippedAgent,
  SkippedLine,
  UploadChips,
  useFileDrop,
  useMeetingUploads,
} from '@/screens/office/MeetingFiles';

interface Message {
  id: number;
  role: 'user' | 'assistant' | 'system';
  author: string;
  content: string;
  ts: string;
  /** 알림 종류. soul_changed 면 data 로 지금 언어 문장을 그린다(OMAI-1126 재검토 D2) */
  kind?: string;
  data?: SoulNoticeData | AttachData | AgentFilesData | ThreadData | { alias: string } | null;
}
/** 「새 대화」 알림(kind=thread_started, 스펙 2026-10-20-027 D6). prev: 앞 차례 id, prev_ok: 그 차례에 말이 남아 있어 열어 볼 수 있다 */
interface ThreadData {
  by: string;
  prev: number;
  prev_ok?: boolean;
}
/** 「지난 대화」 목록의 한 줄(GET /api/office/meeting/threads) */
interface ThreadRow {
  id: number;
  ts: string;
  by: string;
  by_label: string;
  count: number;
  first: string;
  current: boolean;
}
const THREAD_KIND = 'thread_started';
interface SoulNoticeData {
  alias: string;
  pod: string;
  profile: string;
  who: string;
  note?: string;
  ts: string;
  rev_from?: number | null;
  rev_to?: number | null;
  /** 마켓 에이전트 패키지 업데이트로 바뀐 경우 */
  package?: string;
  /** 화면에 보일 패키지 ID(free/x → shared/x, 서버가 준다). 옛 서버는 보내지 않는다 → package 를 보인다 */
  package_label?: string;
  version?: string;
  /** PC 에서 가져오기로 바뀐 경우 'pc_import'. note 는 비어 오고 화면이 문장을 만든다(OMAI-1444 R15) */
  source?: string;
}
/** 회의실 스킬 없는 대상 안내 글자(DD9) — 채팅 안내 줄(NoticeLine)과 같은 호박색 */
const AMBER = '#f59e0b';

/** 서버 meeting.LOST_KIND */
const LOST_KIND = 'reply_lost';

interface MeetingView {
  room: { id: number; name: string; purpose: string; status: string };
  /** label: 화면에 보일 에이전트 이름(서버가 준다, 2026-10-18-010). 없으면 별칭 */
  participants: { alias: string; title: string; pod: string; enabled: boolean; label?: string }[];
  /** 별칭 → 에이전트 이름. 이름이 별칭과 다른 자리만 있다 */
  labels?: Record<string, string>;
  messages: Message[];
  pending: string[];
  /** 신호가 끊긴 서버가 남긴 기다림 — 정리되면 reply_lost 줄이 온다(스펙 2026-10-20-030 DR7). 옛 서버에는 없다 */
  stale?: string[];
  /** 별칭 → 지금까지 쓴 답(스트리밍, 계획 007 P3) */
  partial?: Record<string, string>;
  /** 파일 기능(없으면 옛 서버: 첨부를 보이지 않는다) */
  files?: FilesInfo;
  /** 지금 대화 차례 id(0 = 새 대화를 한 번도 하지 않음)와 돌려준 기록의 차례 id. 없으면 옛 서버 */
  thread?: number;
  viewing?: number;
}

/** 회의록 요약을 Markdown 파일로 내려받는다(방 기록에는 넣지 않는다). */
function download(name: string, text: string) {
  const a = document.createElement('a');
  a.href = URL.createObjectURL(new Blob([text], { type: 'text/markdown;charset=utf-8' }));
  a.download = name;
  a.click();
  URL.revokeObjectURL(a.href);
}

// name: 별칭 → 화면 이름. 자동 별칭(설치본 id)이 알림 글에 그대로 보이지 않게 한다(스펙 2026-10-19-003)
function noticeText(d: SoulNoticeData, name: (alias: string) => string): string {
  const alias = name(d.alias);
  if (d.package) return t('office.soulNoticePackage', { alias, package: d.package_label ?? d.package, version: d.version ?? '' });
  // PC 가져오기: 누가(표시 이름, 관리자 대행이면 「관리자」) PC 에서 가져와 바꿨는지. 판 번호가 있으면 덧붙인다(OMAI-1444 R15)
  if (d.source === 'pc_import') {
    const who = d.who || '';
    if (d.rev_from && d.rev_to && d.rev_from !== d.rev_to) return t('office.soulNoticePcImportRange', { who, alias, from: d.rev_from, to: d.rev_to });
    return d.rev_to ? t('office.soulNoticePcImportRev', { who, alias, rev: d.rev_to }) : t('office.soulNoticePcImport', { who, alias });
  }
  if (d.rev_from && d.rev_to && d.rev_from !== d.rev_to)
    return t('office.soulNoticeRange', { alias, from: d.rev_from, to: d.rev_to });
  return d.rev_to ? t('office.soulNoticeRev', { alias, rev: d.rev_to }) : t('office.soulNotice', { alias });
}

/** SOUL 이 바뀐 알림: 대화 사이의 가운데 정렬 구분선(디자인 결정 13A). 경고가 아니라 안내다 */
function SoulNotice({ d, name }: { d: SoulNoticeData; name: (alias: string) => string }) {
  const me = useMe().data;
  const navigate = useNavigate();
  // 그 POD 를 볼 수 있는 사람에게만 링크를 보인다. 다른 POD 면 전환한 뒤 연다 — 전환은 화면 전체를 새로 고친다(재검토 M1)
  const canSee = !!me && (me.pods ?? []).some((p) => p.id === d.pod);
  const to = `/profiles?name=${encodeURIComponent(d.profile)}&pane=soul`;
  const open = async () => {
    if (me?.pod?.id === d.pod) return navigate(to);
    await switchPod(d.pod);
    window.location.hash = '#' + to;
    window.location.reload();
  };
  return (
    <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
      <Divider sx={{ flex: 1 }} />
      <Box sx={{ textAlign: 'center', maxWidth: '80%' }}>
        <Typography variant="body2" sx={{ whiteSpace: 'pre-wrap', overflowWrap: 'anywhere' }}>
          <InfoOutlinedIcon aria-hidden fontSize="inherit" color="info" sx={{ verticalAlign: '-0.15em', mr: 0.5 }} />
          {noticeText(d, name)}
          {d.note ? ` — ${d.note}` : ''}
        </Typography>
        {/* 합쳐질 때 바뀌는 시각은 다시 읽지 않는다(디자인 결정 15A) */}
        <Typography
          variant="caption"
          color="text.secondary"
          aria-live="off"
          sx={{ display: { xs: 'block', sm: 'inline' } }}
        >
          {[fmtTs(d.ts), d.who && name(d.who)].filter(Boolean).join(' · ')}
        </Typography>
        {canSee && (
          <MuiLink component="button" variant="caption" onClick={open} sx={{ ml: 1 }}>
            {t('office.soulNoticeOpen')}
          </MuiLink>
        )}
      </Box>
      <Divider sx={{ flex: 1 }} />
    </Box>
  );
}

/** 시스템 알림(에이전트가 답하지 못함 등): 앰버 한 줄. 경고 아이콘 + 글자 */
function WarnRow({ children }: { children: ReactNode }) {
  const tk = useChatTokens();
  return (
    <Box
      role="alert"
      sx={{
        my: 1,
        display: 'flex',
        alignItems: 'center',
        gap: 1,
        px: 1.5,
        py: 1,
        bgcolor: tk.warnWash,
        border: `1px solid ${tk.warnLine}`,
        borderRadius: `${chatMetrics.tileRadius}px`,
        fontSize: chatType.name,
      }}
    >
      {/* 테마별 호박색(DESIGN.md: 밝은 #ca8a04 / 어두운 #f59e0b, 디자인 리뷰 2026-10-20-026 DD11) */}
      <WarningAmberRoundedIcon aria-hidden="true" sx={{ fontSize: 18, color: tk.warn, flexShrink: 0 }} />
      <Box sx={{ minWidth: 0, overflowWrap: 'anywhere' }}>{children}</Box>
    </Box>
  );
}

/** 가드레일이 막은 답(kind=guard_blocked, 스펙 2026-10-20-026 F2·디자인 리뷰 DD4~DD6·DD14). 이어진 행은 한 줄로 묶어 받는다.
 *  「다시 말하기」는 입력칸에 그 에이전트들을 @ 로 넣는다 — 차단 직후 다시 쓴 말이 모두에게 퍼지는 것을 막는다. 우회 안내는 두지 않는다. */
function GuardRow({ names, onRetry }: { names: string[]; onRetry?: () => void }) {
  const tk = useChatTokens();
  const shown = names.length > 2 ? t('office.guardBlockedMore', { names: names.slice(0, 2).join(', '), count: names.length - 2 }) : names.join(', ');
  return (
    <WarnRow>
      <span>{t('office.guardBlocked', { names: shown })}</span>
      <Box component="span" sx={{ display: 'block', fontSize: chatType.meta, color: tk.muted }}>
        {t('office.guardBlockedHelp')}
      </Box>
      {onRetry && (
        <MuiLink component="button" type="button" onClick={onRetry} sx={{ fontSize: chatType.meta, minHeight: 44, '@media (pointer: fine)': { minHeight: 0 } }}>
          {t('office.guardRetry', { names: names.map((n) => '@' + n).join(' ') })}
        </MuiLink>
      )}
    </WarnRow>
  );
}

/** 받는 에이전트 칩: 네이티브 체크박스를 품은 label. 접근성 이름은 `별칭 (제목) · pod` 그대로, 눈에 보이는 글자는 별칭이다. */
function RecipientChip({
  p,
  on,
  dim,
  onToggle,
}: {
  p: MeetingView['participants'][number];
  on: boolean;
  dim: boolean;
  onToggle: (on: boolean) => void;
}) {
  const tk = useChatTokens();
  const full = `${p.label || p.alias}${p.title ? ` (${p.title})` : ''} · ${p.pod}`;
  return (
    <Box
      component="label"
      title={full}
      sx={{
        position: 'relative',
        display: 'inline-flex',
        alignItems: 'center',
        gap: 0.75,
        flexShrink: 0,
        maxWidth: chatMetrics.chipMax,
        px: 1.25,
        py: 0.5,
        borderRadius: 999,
        fontSize: chatType.meta + 1,
        cursor: p.enabled ? 'pointer' : 'not-allowed',
        border: `1px solid ${on ? tk.composerFocus : tk.line}`,
        bgcolor: on ? tk.selected : 'transparent',
        color: on ? tk.text : tk.muted,
        opacity: !p.enabled ? 0.5 : dim ? 0.45 : 1,
        // 키보드 초점일 때만 초점 링. :focus-within 은 마우스로 눌러도 맞아 칩마다 빨간 테두리가 남았다(2026-10-18, focusRing.test)
        '&:has(input:focus-visible)': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 1 },
        '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
      }}
    >
      <input
        type="checkbox"
        aria-label={full}
        checked={on}
        disabled={!p.enabled}
        onChange={(e) => onToggle(e.target.checked)}
        style={{
          position: 'absolute',
          inset: 0,
          width: '100%',
          height: '100%',
          margin: 0,
          opacity: 0,
          cursor: 'inherit',
        }}
      />
      <AgentDot name={p.alias} />
      <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
        {p.label || p.alias}
      </Box>
    </Box>
  );
}

const hiddenSx = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

/** 「새 대화」 알림: SOUL 알림과 같은 가운데 줄(DR3). 경고가 아니므로 role=status. 앞 차례에 말이 남아 있으면 「지난 대화 보기」(DR10) */
function ThreadNotice({ m, name, onOpenPrev }: { m: Message; name: (who: string) => string; onOpenPrev?: (thread: number) => void }) {
  const d = (m.data ?? {}) as ThreadData;
  return (
    <Box role="status" sx={{ display: 'flex', alignItems: 'center', gap: 1, my: 1 }}>
      <Divider sx={{ flex: 1 }} />
      <Box sx={{ textAlign: 'center', maxWidth: '80%' }}>
        <Typography component="span" sx={{ fontSize: chatType.meta, color: 'text.secondary', overflowWrap: 'anywhere' }}>
          {t('office.threadStarted', { name: name(d.by || m.author) })}
          {' · '}
          {fmtTs(m.ts)}
        </Typography>
        {d.prev_ok && onOpenPrev && (
          <MuiLink component="button" type="button" variant="caption" onClick={() => onOpenPrev(d.prev)} sx={{ ml: 1 }}>
            {t('office.threadPrevOpen')}
          </MuiLink>
        )}
      </Box>
      <Divider sx={{ flex: 1 }} />
    </Box>
  );
}

/** 회의 기록 목록. 지금 대화와 읽기 전용 지난 대화가 같은 그리기 코드를 쓴다(스펙 2026-10-20-027 D2 B). */
function MessageList({
  d,
  roomId,
  lab,
  enter,
  retry,
  onOpenPrev,
  askAgain,
  read,
}: {
  d: MeetingView;
  roomId: number;
  lab: (alias: string) => string;
  enter: boolean;
  retry?: (aliases: string[]) => (() => void) | undefined;
  onOpenPrev?: (thread: number) => void;
  /** 「다시 묻기」(서버가 다시 시작돼 답을 받지 못한 줄, DR6). 없으면 링크가 없다(지난 대화) */
  askAgain?: (aliases: string[], mid: number | null) => (() => void) | undefined;
  /** 답 「읽어 주기」(스펙 2026-10-28-012 DD13): 상태 키의 대화와 읽힐 내 에이전트. 내 에이전트가 없으면 target 이 없어 단추를 그리지 않는다 */
  read?: { conv: string; target?: ReadTarget };
}) {
  const rs = useReadSnap();
  const heads = groupMeeting(d.messages);
  const guards = guardGroups(d.messages);
  return (
    <>
      {d.messages.map((m, i) => {
        const gap = { mt: i === 0 ? 0 : !heads[i] ? 0.5 : 2.5 };
        // 가드레일 차단 줄: 이어진 행은 첫 행에서 한 줄로(DD6). role=system 분기보다 먼저 잡는다(DD5)
        const g = guards[i];
        if (g === 'skip') return null;
        if (m.kind === GUARD_KIND && g)
          return (
            <Box key={m.id} sx={gap}>
              <GuardRow names={g.map(lab)} onRetry={retry?.(g)} />
            </Box>
          );
        if (m.kind === 'soul_changed' && m.data)
          return (
            <Box key={m.id} sx={gap}>
              <SoulNotice d={m.data as SoulNoticeData} name={lab} />
            </Box>
          );
        // 「새 대화」 알림: kind 없는 시스템 행(앰버 경고 줄)으로 그리지 않는다(DR3)
        if (m.kind === THREAD_KIND)
          return (
            <Box key={m.id} sx={gap}>
              <ThreadNotice m={m} name={lab} onOpenPrev={onOpenPrev} />
            </Box>
          );
        // 서버가 다시 시작돼 답을 받지 못했다(스펙 2026-10-20-030 R8). kind 없는 시스템 행(앰버 경고)과 따로 — 가드레일 줄과 같은 모양.
        // 같은 때 정리된 여러 에이전트는 첫 행에서 한 줄로 묶는다(DR6)
        if (m.kind === LOST_KIND) {
          if (d.messages[i - 1]?.kind === LOST_KIND) return null;
          const run: Message[] = [];
          for (let j = i; j < d.messages.length && d.messages[j].kind === LOST_KIND; j++) run.push(d.messages[j]);
          const aliases = run.map((x) => String((x.data as { alias?: string } | null)?.alias ?? x.author));
          const mid = (run[0].data as { mid?: number | null } | null)?.mid ?? null;
          return (
            <Box key={m.id} sx={gap}>
              <LostReplyRow text={t('office.replyLost', { name: aliases.map(lab).join(', ') })} onAskAgain={askAgain?.(aliases, mid)} />
            </Box>
          );
        }
        // 에이전트가 만든 파일: role 은 system 이어도 경고 행이 아니라 파일 칩 행이다(스펙 §4-4)
        if (m.kind === 'files')
          return (
            <Box key={m.id} sx={gap}>
              <AgentFilesRow
                room={roomId}
                msg={{ id: m.id, author: m.author, ts: m.ts, data: m.data as AgentFilesData | null }}
                name={lab(m.author)}
                enter={enter}
                info={d.files}
              />
            </Box>
          );
        if (m.role === 'system') return <WarnRow key={m.id}>{m.content}</WarnRow>;
        if (m.role === 'user')
          return (
            <Box key={m.id} sx={gap}>
              <MessageRow
                side="mine"
                enter={enter}
                foot={
                  m.kind === 'attach' && m.data ? (
                    <AttachFoot
                      room={roomId}
                      data={m.data as AttachData}
                      meta={t('office.authorMine', { author: lab(m.author), ts: fmtTs(m.ts) })}
                    />
                  ) : (
                    t('office.authorMine', { author: lab(m.author), ts: fmtTs(m.ts) })
                  )
                }
              >
                {m.content}
              </MessageRow>
            </Box>
          );
        return (
          <Box key={m.id} sx={gap}>
            <MessageRow
              side="agent"
              enter={enter}
              pinActions={!!read && readPinned(rs, read.conv, String(m.id))}
              actions={
                m.content ? (
                  <>
                    <CopyButton text={m.content} />
                    {read && <ReadAloudButton target={read.target} conv={read.conv} msg={String(m.id)} name={lab(m.author)} text={m.content} />}
                  </>
                ) : undefined
              }
              head={
                heads[i]
                  ? {
                      avatar: <AgentAvatar name={m.author} label={lab(m.author)} size={chatMetrics.rowAvatar} tone="hue" />,
                      name: lab(m.author),
                      time: fmtTs(m.ts),
                    }
                  : undefined
              }
            >
              <Markdown text={m.content} />
            </MessageRow>
          </Box>
        );
      })}
    </>
  );
}

const threadsKey = (roomId: number) => ['meeting-threads', roomId];
const fetchThreads = (roomId: number) => get<{ threads: ThreadRow[]; current: number }>(`/api/office/meeting/threads?room=${roomId}`);

/** 「지난 대화」 목록과 상세를 연다. 상세는 목록 위에 쌓는 서랍(DR8). 오피스 장면 위 창(compact)은 서랍을 가리므로
 *  창을 닫고 큰 회의 화면으로 옮겨 연다 — 창의 「회의 화면에서 크게 보기」와 같은 길(DR13). */
function usePastOpener(roomId: number, roomName: string, compact: boolean) {
  const { openDrawer, closeDrawer } = useUi();
  const qc = useQueryClient();
  const navigate = useNavigate();
  const toBig = (extra: string) => {
    closeRoomChat();
    navigate(`/office?tab=meeting&room=${roomId}&past=1${extra}`);
  };
  const openPast = async (thread: number) => {
    if (compact) return toBig(`&thread=${thread}`);
    let row: ThreadRow | undefined;
    try {
      row = (await qc.fetchQuery({ queryKey: threadsKey(roomId), queryFn: () => fetchThreads(roomId), staleTime: 0 })).threads.find((r) => r.id === thread);
    } catch {
      row = undefined; // 목록을 못 읽어도 상세는 연다(상세가 자기 오류를 보인다)
    }
    const ts = row ? fmtTs(row.ts) : '';
    openDrawer({
      title: ts ? t('office.pastDetailTitle', { ts }) : t('office.pastTitle'),
      sub: row
        ? row.by
          ? t('office.pastDetailSub', { name: row.by_label || row.by, n: row.count })
          : t('office.pastDetailSubNoBy', { n: row.count })
        : roomName,
      body: <MeetingRoom roomId={roomId} name={roomName} canAct={false} thread={thread} pastTs={ts} />,
    });
  };
  const openList = () => {
    if (compact) return toBig('');
    openDrawer({
      title: t('office.pastTitle'),
      sub: t('office.pastSub', { name: roomName }),
      body: <PastList roomId={roomId} onOpen={(id) => void openPast(id)} onCurrent={() => void closeDrawer()} />,
    });
  };
  return { openList, openPast };
}

/** 지난 대화 목록(DR6·DR12). 채팅 「지난 대화」 서랍과 같은 부품. 최근 것이 앞, 지금 대화에는 「지금 대화」 */
function PastList({ roomId, onOpen, onCurrent }: { roomId: number; onOpen: (thread: number) => void; onCurrent: () => void }) {
  const q = useQuery({ queryKey: threadsKey(roomId), queryFn: () => fetchThreads(roomId), staleTime: 0 });
  if (q.isError) return <ErrorRow>{(q.error as Error).message}</ErrorRow>;
  if (!q.data) return <Typography color="text.secondary">{t('chat.loading')}</Typography>;
  const past = q.data.threads.filter((r) => !r.current);
  return (
    <ItemList>
      {q.data.threads.map((r) => (
        <ItemRow
          key={r.id}
          icon={ChatBubbleOutlineIcon}
          name={r.first || (r.id === 0 ? t('office.pastFirst') : t('office.pastNoWords'))}
          rowTitle={r.first || undefined}
          onRow={() => (r.current ? onCurrent() : onOpen(r.id))}
          tags={r.current ? <Tag tone="good">{t('office.pastNow')}</Tag> : undefined}
          description={
            r.by
              ? t('office.pastMeta', { ts: fmtTs(r.ts), by: r.by_label || r.by, n: r.count })
              : t('office.pastMetaNoBy', { ts: fmtTs(r.ts), n: r.count })
          }
        />
      ))}
      {!past.length && <ItemEmpty>{t('office.pastNone')}</ItemEmpty>}
    </ItemList>
  );
}

/** 지난 대화 하나(읽기 전용, DR8·DR14). 입력·받는 사람·파일 올리기·실시간 읽기가 없고 낭독기에는 정적 기록으로 알린다. */
function PastRoom({ roomId, thread, pastTs = '' }: { roomId: number; thread: number; pastTs?: string }) {
  const tk = useChatTokens();
  const end = useRef<HTMLDivElement>(null);
  const q = useQuery<MeetingView>({
    queryKey: ['meeting', roomId, 'thread', thread],
    queryFn: () => get<MeetingView>(`/api/office/meeting?room=${roomId}&thread=${thread}`),
    retry: (n, e) => !(e instanceof ApiError && e.status === 404) && n < 2,
  });
  const d = q.data;
  const { openPast } = usePastOpener(roomId, d?.room.name ?? '', false);
  const count = d?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' }); // 처음 열면 맨 아래(마지막 말)
  }, [count]);
  const lab = (alias: string) => d?.labels?.[alias] ?? alias;
  const gone = q.error instanceof ApiError && q.error.status === 404;
  // 지난 대화의 답도 내 에이전트로 읽는다. 서랍을 닫으면 멈춘다(DD11)
  const voice = useMyVoice();
  const readConv = `meeting:${roomId}:thread:${thread}`;
  useReadScope(readConv);
  const readTarget = voice && { pod: voice.pod, profile: voice.profile, tts: voice.tts, voices: voice.ttsVoices };
  return (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0 }}>
      <Typography sx={{ fontSize: chatType.meta, color: tk.muted, pb: 1 }}>{t('office.pastReadOnly')}</Typography>
      {q.isLoading && <LinearProgress aria-label={t('office.meetingLoading')} />}
      <Box role="region" aria-label={t('office.pastLog', { ts: pastTs })}>
        {q.isError &&
          (gone ? (
            <Typography sx={{ color: tk.muted, fontSize: chatType.name }}>{t('office.pastNotFound')}</Typography>
          ) : (
            <ErrorRow
              action={
                <Button startIcon={<RefreshIcon />} size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={() => void q.refetch()}>
                  {t('office.meetingRetry')}
                </Button>
              }
            >
              {t('office.meetingLoadFailed', { error: (q.error as Error)?.message ?? '' })}
            </ErrorRow>
          ))}
        {d && !d.messages.length && <Typography sx={{ color: tk.muted, fontSize: chatType.name }}>{t('office.pastEmptyLog')}</Typography>}
        {d && <MessageList d={d} roomId={roomId} lab={lab} enter={false} onOpenPrev={(id) => void openPast(id)} read={{ conv: readConv, target: readTarget }} />}
        <div ref={end} />
      </Box>
    </Box>
  );
}

/** 머리줄 단추. 채팅 머리줄(barBtn)과 같은 규칙: 넓으면 아이콘 + 짧은 글자, lg 미만·떠 있는 창이면 아이콘만(이름은 툴팁·aria-label, DR2).
 *  blocked: 막힌 이유. 눌러도 동작하지 않고 이유를 알린다 — disabled 단추는 툴팁이 뜨지 않고 터치에서는 이유를 볼 길이 없다(DR15) */
function HeadBtn({
  label,
  short,
  icon,
  iconOnly,
  tip,
  blocked,
  waiting,
  onClick,
}: {
  label: string;
  short: string;
  icon: ReactNode;
  iconOnly: boolean;
  tip?: string;
  blocked?: string;
  waiting?: boolean;
  onClick: () => void;
}) {
  return (
    <Tooltip title={blocked || tip || label} describeChild={!!(blocked || tip)}>
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        aria-label={label}
        aria-disabled={blocked || waiting ? true : undefined}
        startIcon={iconOnly ? undefined : icon}
        onClick={onClick}
        sx={[
          tier2 as object,
          iconOnly ? { minWidth: 0, px: 0.75 } : {},
          blocked || waiting ? { opacity: 0.5 } : {},
          { flexShrink: 0, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } },
        ]}
      >
        {iconOnly ? icon : short}
      </Button>
    </Tooltip>
  );
}

export interface MeetingRoomProps {
  roomId: number;
  /** 방 목록에서 이미 아는 이름·목적. 있으면 첫 응답 전에도 머리줄에 보인다 */
  name?: string;
  purpose?: string;
  canAct: boolean;
  /** 주면 좁은 화면(md 미만)에서 방 목록으로 돌아가는 단추를 보인다 */
  onBack?: () => void;
  /** 떠 있는 창(3D 오피스의 회의실 채팅): 머리줄을 세로로 쌓고 입력 카드를 compact 로 그린다 */
  compact?: boolean;
  paneSx?: SxProps<Theme>;
  /** 주면 머리줄에 「방 정보 고치기」 단추를 보인다(TFT 방·관리자, 스펙 2026-10-18-007) */
  onEdit?: () => void;
  /** 주면 그 대화 차례를 읽기 전용으로 보인다(「지난 대화」 서랍, 스펙 2026-10-20-027 D2 B) */
  thread?: number;
  /** 읽기 전용 기록의 접근 이름에 붙일 시작 시각 */
  pastTs?: string;
  /** 처음 그릴 때 「지난 대화」를 연다(창에서 옮겨 온 주소 ?past=1&thread=, DR13). thread 가 없으면 목록 */
  initialPast?: { thread?: number };
  /** initialPast 를 처리한 뒤 부른다(주소에서 past·thread 를 지운다) */
  onPastHandled?: () => void;
}

/** 방 하나의 대화(머리줄·기록·입력). 회의 화면(오피스 › 회의)과 3D 오피스의 회의실 채팅 창이 함께 쓴다(OMAI-1257).
 *  thread 를 주면 지난 대화 하나를 읽기 전용으로 그린다. */
export function MeetingRoom(props: MeetingRoomProps) {
  if (props.thread !== undefined) return <PastRoom roomId={props.roomId} thread={props.thread} pastTs={props.pastTs} />;
  return <LiveRoom {...props} />;
}

function LiveRoom({ roomId, name = '', purpose = '', canAct, onBack, compact = false, paneSx, onEdit, initialPast, onPastHandled }: MeetingRoomProps) {
  const qc = useQueryClient();
  const tk = useChatTokens();
  const confirm = useConfirm();
  const iconOnly = useMediaQuery(useTheme().breakpoints.down('lg')) || compact;
  const [text, setText] = useState('');
  const [skip, setSkip] = useState<string[]>([]);
  // 이번 한 말만 좁힌 받는 사람(@ 로 부른 말 뒤, 스펙 2026-10-20-026 R4b·디자인 리뷰 DD7). skip(사용자가 정함)과 따로 둬 보낸 뒤 그대로 돌아간다
  const [narrow, setNarrow] = useState<string[] | null>(null);
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  const [summarizing, setSummarizing] = useState(false);
  const [starting, setStarting] = useState(false);
  // 다른 사람이 새 대화를 시작했을 때 입력칸에 쓰던 글이 있으면 알린다(DR11). 값은 시작한 사람 이름
  const [threadNote, setThreadNote] = useState('');
  const end = useRef<HTMLDivElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const first = useRef(true);
  const [live, setLive] = useState({ n: 0, text: '' });
  const prevPending = useRef<string[]>([]);
  const prevThread = useRef<number | undefined>(undefined);
  const mine = useRef<number | null>(null);
  const pastDone = useRef(false);
  const [skipped, setSkipped] = useState<SkippedAgent[]>([]);
  const { openDrawer } = useUi();

  // 웹소켓이면 서버가 새 말과 답을 보낸다(OMAI-1100). 아니면 기다리는 답이 있을 때 1.5초, 없으면 5초마다 읽는다
  const live_ = useTopic<MeetingView>(`office:meeting:${roomId}`, (d) => qc.setQueryData(['meeting', roomId], d));
  // 읽기가 이어서 실패한 수와 처음 실패한 때(스펙 2026-10-20-030 4-8). react-query 의 fetchFailureCount 는 읽기를 시작할 때마다 0 이 되어 쓸 수 없다(M1)
  const fails = useRef(0);
  const downSince = useRef(0);
  const q = useQuery<MeetingView>({
    queryKey: ['meeting', roomId],
    queryFn: () => get<MeetingView>(`/api/office/meeting?room=${roomId}`),
    refetchInterval: (query) =>
      live_ ? false : fails.current > 0 ? backoffDelay(fails.current) : query.state.data?.pending.length || query.state.data?.stale?.length ? 1500 : 5000,
  });
  useEffect(() => {
    if (!q.errorUpdatedAt) return;
    fails.current += 1;
    downSince.current ||= Date.now();
  }, [q.errorUpdatedAt]);
  useEffect(() => {
    if (!q.dataUpdatedAt || !fails.current) return;
    fails.current = 0;
    downSince.current = 0;
  }, [q.dataUpdatedAt]);
  const d = q.data;
  // 받은 기록이 있는데 다시 읽기가 실패하는 동안: 빨간 오류 줄 대신 회색 「다시 읽는 중」, 5분이 지나면 빨간 줄(DR8)
  const reloading = q.isError && !!d;
  const longDown = reloading && downSince.current > 0 && Date.now() - downSince.current >= RETRY_MAX_MS;
  const connWait = useConnWait();
  const blockedNet = connWait || reloading;
  // 말로 입력: 받는 에이전트 수와 관계없이 내 에이전트의 주 프로파일로 받아쓴다. 막힘은 blockedNet 이 아니라 내 에이전트의 연결 상태다(스펙 2026-10-22-005 R9·R11·11A)
  const voice = useMyVoice();
  // 답 「읽어 주기」도 내 에이전트의 주 프로파일로 읽는다(스펙 2026-10-28-012 DD13). 방을 나가거나 창을 닫으면 멈춘다(DD11)
  const readConv = `meeting:${roomId}:${d?.thread ?? 0}`; // 「새 대화」로 차례가 바뀌어도 멈춘다
  useReadScope(readConv);
  const readTarget = voice && { pod: voice.pod, profile: voice.profile, tts: voice.tts, voices: voice.ttsVoices };
  const readNow = () => {
    downSince.current = Date.now(); // 사람이 누르면 한도를 새로 센다(DR10)
    void q.refetch();
  };
  const roomName = d?.room.name ?? name;
  const roomPurpose = briefSummary(d?.room.purpose ?? purpose ?? ''); // 머리에는 「목표」 첫 줄만(2026-10-18-004)
  const past = usePastOpener(roomId, roomName, compact);
  // 에이전트가 모이는 회의실(장면과 같은 규칙). 큰 팀 회의는 대회의실(스펙 2026-10-20-017 디자인 리뷰 이슈 8)
  const place = useMeetingPlace(roomId);
  // 파일 기능이 켜졌고 방이 열려 있을 때만 첨부를 보인다(끝난 방은 목록에서 이미 빠진다)
  const filesInfo = d?.files?.enabled && d.room.status !== 'closed' ? d.files : undefined;
  const up = useMeetingUploads(roomId, filesInfo);
  const drop = useFileDrop(!!filesInfo && canAct, up.add);
  useEffect(() => {
    setSkipped([]);
    setNarrow(null); // 좁힘은 그 방의 다음 한 말에만 — 다른 방으로 넘어가지 않는다
  }, [roomId]);
  const count = d?.messages.length ?? 0;
  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [count]);
  useEffect(() => {
    first.current = false; // 처음 그린 뒤에 붙는 행만 120ms 전환을 쓴다
  }, []);
  // 창에서 옮겨 온 주소(?past=1)면 처음 한 번 「지난 대화」를 연다(DR13)
  useEffect(() => {
    if (!initialPast) pastDone.current = false; // 주소에서 지운 뒤 다시 ?past=1 로 오면 또 연다
    if (!initialPast || !d || pastDone.current) return;
    pastDone.current = true;
    if (initialPast.thread !== undefined) void past.openPast(initialPast.thread);
    else past.openList();
    onPastHandled?.();
  }, [initialPast, !!d]); // eslint-disable-line react-hooks/exhaustive-deps
  // 다른 사람이 새 대화를 시작했고 쓰던 글이 있으면 입력칸 위에 한 줄로 알린다. 내가 시작한 것은 알리지 않는다(DR11)
  useEffect(() => {
    if (d?.thread === undefined) return;
    if (prevThread.current !== undefined && d.thread !== prevThread.current && d.thread !== mine.current && text.trim()) {
      const by = (d.messages.find((m) => m.kind === THREAD_KIND)?.data as ThreadData | undefined)?.by ?? '';
      setThreadNote(by ? d.labels?.[by] ?? by : '');
    }
    prevThread.current = d.thread;
  }, [d?.thread]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (!text.trim()) setThreadNote('');
  }, [text]);
  // 답을 기다리던 에이전트가 끝나면 한 번 알린다(스트리밍 중에는 aria-busy 로 조각을 읽지 않는다, 디자인 리뷰 6-2)
  // 기다림은 살아 있는 서버의 것(pending)과 정리 전 죽은 서버의 것(stale)을 합쳐 본다 — 입력 중에서 「확인하는 중」으로 바뀔 때 「답이 도착했습니다」를 읽지 않게(DR7)
  const staleNow = (d?.stale ?? []).filter((a) => !(d?.pending ?? []).includes(a));
  const pendingNow = [...(d?.pending ?? []), ...staleNow];
  useEffect(() => {
    // 가드레일에 막힌 에이전트는 「답이 도착했습니다」를 읽지 않는다 — 차단 줄(role=alert)이 알린다(디자인 리뷰 DD12)
    const blocked = blockedLast(d?.messages ?? []);
    const done = prevPending.current.filter((a) => !pendingNow.includes(a) && !blocked.has(a));
    if (done.length)
      setLive((l) => ({ n: l.n + 1, text: done.map((a) => t('office.replyArrived', { name: a })).join(', ') }));
    prevPending.current = pendingNow;
  }, [pendingNow.join('|')]); // eslint-disable-line react-hooks/exhaustive-deps

  // 다시 읽는 중으로 바뀔 때와 돌아올 때 한 번씩 알린다(DR9·DR12)
  const wasReloading = useRef(false);
  useEffect(() => {
    if (reloading !== wasReloading.current)
      setLive((l) => ({ n: l.n + 1, text: reloading ? t('office.reconnect.meeting') : t('office.reconnect.back') }));
    wasReloading.current = reloading;
  }, [reloading]);

  // 「@이름」 으로 시작하면 그 에이전트만 부른다(계획 007 P2). 없으면 고른 참가자 모두에게
  const participants = d?.participants ?? [];
  const lab = (alias: string) => d?.labels?.[alias] ?? alias; // 에이전트 이름(2026-10-18-010). 점 색·묶음은 별칭 기준이라 name 은 그대로 둔다
  const checked = participants
    .filter((p) => p.enabled && (narrow ? narrow.includes(p.alias) : !skip.includes(p.alias)))
    .map((p) => p.alias);
  // 좁혀 둔 대상이 모두 꺼지거나 빠지면 좁힘을 풀고 한 번 알린다 — 받는 사람 0명으로 보내기가 막히지 않게(디자인 리뷰 DD8)
  const narrowGone = !!d && !!narrow && !participants.some((p) => p.enabled && narrow.includes(p.alias));
  useEffect(() => {
    if (!narrowGone) return;
    setNarrow(null);
    setLive((l) => ({ n: l.n + 1, text: t('office.narrowReleased') }));
  }, [narrowGone]);
  // 「@이름」·「@별칭」으로 부른 참가자(스펙 2026-10-19-012 P5). 한글·띄어쓰기 이름도 긴 이름부터 맞추고, 칩으로 끈 참가자도 받는다(D3)
  const people = participants.filter((p) => p.enabled).map((p) => ({ alias: p.alias, label: p.label || p.alias }));
  const mentioned = findMentions(text, people);
  const targets = mentioned.length ? mentioned : checked;
  const noRecipient = !!d && participants.length > 0 && targets.length === 0;
  // 「/」 스킬: 받는 대상이 가진 스킬을 합쳐 보이고 「2/3 에이전트」를 단다(D2·DD9). 목록은 처음 열 때 읽는다
  const meetingSkills = useSkillSuggest(canAct ? `/api/office/meeting/skills?room=${roomId}` : null);
  const skillItems = skillSuggestItems(meetingSkills.data, { targets, label: lab });
  const skillStart = (v: string) => afterLeadingMentions(v, people);
  const chosen = leadingCommand(text, skillItems, skillStart(text));
  const missing = chosen ? missingFor(meetingSkills.data, chosen.value, targets, lab) : [];
  const failedNames = (meetingSkills.data?.failed ?? []).map(lab);
  const agentItems: SuggestItem[] = participants
    .filter((p) => p.enabled && !mentioned.includes(p.alias)) // 이미 부른 참가자는 빼고(DD8)
    .map((p) => {
      const name = p.label || p.alias;
      const off = skip.includes(p.alias);
      return {
        value: '@' + name,
        label: name,
        detail: p.title || undefined,
        hint: off ? t('office.suggest.off') : undefined,
        ariaLabel: off ? t('office.suggest.offAria', { name }) : undefined,
        dot: hueOf(p.alias),
      };
    });
  const send = async () => {
    setBusy(true);
    setError('');
    setSkipped([]);
    try {
      const r = await post<{ skipped?: SkippedAgent[] }>('/api/office/meeting/say', {
        room: roomId,
        text,
        targets,
        ...(up.ids.length ? { files: up.ids } : {}),
        ...(chosen ? { skill: chosen.value.slice(1) } : {}),
      });
      setText('');
      setThreadNote('');
      setSkipped(r?.skipped ?? []);
      // @ 로 부른 말(여러 명·위치 무관)이면 다음 한 말을 그 대상으로 좁힌다. 이번 말을 건너뛴 대상은 뺀다. 아니면 좁힘을 다 쓴 것으로 친다(R4b·DD8·DD9)
      const missed = (r?.skipped ?? []).map((x) => x.alias);
      const next = mentioned.filter((a) => !missed.includes(a));
      setNarrow(next.length ? next : null);
      if (next.length)
        setLive((l) => ({ n: l.n + 1, text: t('office.narrowLive', { names: next.map((a) => '@' + lab(a)).join(' ') }) }));
      up.consumeDone();
      await qc.invalidateQueries({ queryKey: ['meeting', roomId] });
      void qc.invalidateQueries({ queryKey: ['meeting-files', roomId] });
      composer.current?.focus(); // 보낸 뒤에도 다음에 쓸 곳은 입력칸이다(디자인 리뷰 3-1)
    } catch (e) {
      setError(fileErrorText(e, filesInfo));
    } finally {
      setBusy(false);
    }
  };
  // 「새 대화」(스펙 2026-10-20-027). 끝난 방·답하는 중·내가 방금 보낸 말이 아직 화면에 안 온 동안은 막는다(DR4·DR15)
  const newChatBlocked =
    d?.room.status === 'closed' ? t('office.newChatClosed') : pendingNow.length > 0 || busy ? t('office.newChatBusy') : '';
  const startNew = async () => {
    if (starting) return;
    if (newChatBlocked) {
      setError(newChatBlocked);
      return;
    }
    const ok = await confirm(t('office.newChatConfirm'), {
      title: t('office.newChatConfirmTitle'),
      confirmLabel: t('office.newChatConfirmButton'),
      cancelFirst: true,
    });
    if (!ok) return;
    setStarting(true);
    setError('');
    try {
      const r = await post<{ thread: number }>('/api/office/meeting/new', { room: roomId });
      mine.current = r.thread;
      setThreadNote('');
      await qc.invalidateQueries({ queryKey: ['meeting', roomId] });
      void qc.invalidateQueries({ queryKey: threadsKey(roomId) });
      setLive((l) => ({ n: l.n + 1, text: t('office.newChatDone') }));
      composer.current?.focus();
    } catch (e) {
      const reason = e instanceof ApiError ? e.reason : '';
      setError(
        reason === 'busy'
          ? t('office.newChatBusy')
          : reason === 'closed'
          ? t('office.newChatClosed')
          : t('office.newChatFailed', { error: (e as Error).message })
      );
    } finally {
      setStarting(false);
    }
  };
  const summarize = async () => {
    if (summarizing) return;
    setSummarizing(true);
    setError('');
    try {
      const r = await post<{ markdown: string }>('/api/office/meeting/summary', { room: roomId });
      download(t('office.summaryFile', { name: roomName }), r.markdown);
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setSummarizing(false);
    }
  };
  // 사람·에이전트의 말(시스템 행 제외). 「새 대화」 알림 한 줄만 있으면 요약할 기록이 없다(R13)
  const talked = (d?.messages ?? []).some((m) => m.role !== 'system');
  // 「다시 말하기」: 묶인 에이전트 중 지금 켜진 참가자만 @ 로 넣고 입력칸으로 간다. 끝난 방·모두 꺼짐이면 단추가 없다(DD4)
  const retry = (aliases: string[]) => {
    const on = aliases.filter((a) => participants.some((p) => p.alias === a && p.enabled));
    if (!canAct || d?.room.status === 'closed' || !on.length) return undefined;
    return () => {
      setText(on.map((a) => '@' + lab(a)).join(' ') + ' ');
      composer.current?.focus();
    };
  };
  // 「다시 묻기」(DR6): 「다시 말하기」와 같은 조건에서만 보이고, 입력 칸이 비었을 때만 @이름과 원래 말을 채운다(쓰던 글을 덮지 않는다).
  // 원래 말(mid)을 모르면(옛 행·다른 차례) 링크가 없다. 첨부는 다시 채우지 않는다
  const askAgain = (aliases: string[], mid: number | null) => {
    const on = aliases.filter((a) => participants.some((p) => p.alias === a && p.enabled));
    const orig = mid ? d?.messages.find((m) => m.id === mid && m.role === 'user')?.content : undefined;
    if (!canAct || d?.room.status === 'closed' || !on.length || !orig) return undefined;
    return () => {
      if (!text.trim()) setText(on.map((a) => '@' + lab(a)).join(' ') + ' ' + orig);
      composer.current?.focus();
    };
  };
  const small = { fontSize: chatType.meta, color: tk.muted } as const;
  const reasonId = 'meeting-recipient-reason';

  return (
    <Box
      {...drop.bind}
      sx={[
        { display: 'flex', flexDirection: 'column', minHeight: 0, minWidth: 0, position: 'relative' },
        ...(Array.isArray(paneSx) ? paneSx : [paneSx]),
      ]}
    >
      {q.isLoading && (
        <LinearProgress
          aria-label={t('office.meetingLoading')}
          sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 1 }}
        />
      )}
      {drop.dragging && <DropOverlay />}
      {/* 떠 있는 창(compact)은 이름과 단추를 한 줄에 두고 단추를 오른쪽 끝에 붙인다 — 세로로 쌓으면 머리줄이 대화 칸을 크게 차지했다(스펙 2026-10-20-028) */}
      <Stack
        direction={compact ? 'row' : { xs: 'column', md: 'row' }}
        spacing={compact ? 1 : { xs: 1, md: 1.5 }}
        alignItems={compact ? 'center' : { xs: 'stretch', md: 'flex-start' }}
        justifyContent="space-between"
        sx={{ px: 2, py: 1.25, borderBottom: `1px solid ${tk.line}`, bgcolor: tk.rail, minHeight: 56 }}
      >
        <Stack direction="row" spacing={1} alignItems="center" sx={{ minWidth: 0, flex: compact ? 1 : { md: 1 } }}>
          {onBack && (
            <IconButton
              aria-label={t('office.meetingBackToRooms')}
              onClick={onBack}
              sx={{
                display: { md: 'none' },
                '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch },
              }}
            >
              <ArrowBackIcon />
            </IconButton>
          )}
          <Box sx={{ minWidth: 0 }}>
            <Box
              component="h2"
              title={roomName}
              sx={{
                m: 0,
                fontSize: 14,
                fontWeight: 700,
                overflow: 'hidden',
                textOverflow: 'ellipsis',
                whiteSpace: 'nowrap',
              }}
            >
              {roomName}
            </Box>
            {roomPurpose && (
              <Typography noWrap title={roomPurpose} sx={{ ...small, fontSize: 12 }}>
                {roomPurpose}
              </Typography>
            )}
            {place && (
              <Typography noWrap sx={{ ...small, fontSize: 12 }}>
                {t('office.meetingPlace', { name: place })}
              </Typography>
            )}
          </Box>
        </Stack>
        {/* 머리줄 순서: 자주 쓰는 것(지난 대화·자료·요약) → 조금 띄움 → 방 전체에 미치는 새 대화 → 방 정보 고치기(DR1). 「지난 대화」는 방을 보는 사람 모두(DR7) */}
        <Stack
          direction="row"
          spacing={1}
          alignItems="center"
          flexWrap={compact ? 'nowrap' : 'wrap'}
          useFlexGap
          sx={{ flexShrink: 0, justifyContent: compact ? 'flex-end' : { xs: 'flex-start', md: 'flex-end' } }}
        >
          <HeadBtn
            label={t('office.pastChats')}
            short={t('office.pastChatsShort')}
            icon={<HistoryOutlinedIcon sx={{ fontSize: 18 }} />}
            iconOnly={iconOnly}
            onClick={past.openList}
          />
          {d?.files?.enabled && (
            <HeadBtn
              label={t('office.meetingFiles')}
              short={t('office.meetingFiles')}
              icon={<FolderOpenOutlinedIcon sx={{ fontSize: 18 }} />}
              iconOnly={iconOnly}
              onClick={() =>
                openDrawer({
                  title: t('office.meetingFilesTitle'),
                  sub: roomName,
                  body: <MeetingFilesDrawer room={roomId} info={d.files as FilesInfo} onAttach={canAct && filesInfo ? up.add : undefined} />,
                })
              }
            />
          )}
          {/* 요약 비용 안내는 툴팁에(사용자 결정 2026-10-20). 아이콘만일 때는 이름과 함께 보인다(DR2) */}
          {canAct && talked && (
            <HeadBtn
              label={summarizing ? t('office.summaryWorking') : t('office.summary')}
              short={summarizing ? t('office.summaryWorking') : t('office.summaryShort')}
              icon={<SummarizeOutlinedIcon sx={{ fontSize: 18 }} />}
              iconOnly={iconOnly}
              tip={
                summarizing
                  ? undefined
                  : (iconOnly ? t('office.summary') + ' · ' : '') + t('office.summaryCost', { alias: lab(d?.participants[0]?.alias ?? '') })
              }
              waiting={summarizing}
              onClick={() => void summarize()}
            />
          )}
          {canAct && (
            <Box sx={{ display: 'flex', gap: 1, ml: 1 }}>
              <HeadBtn
                label={t('office.newChat')}
                short={t('office.newChatShort')}
                icon={<AddCommentOutlinedIcon sx={{ fontSize: 18 }} />}
                iconOnly={iconOnly}
                blocked={newChatBlocked || undefined}
                waiting={starting}
                onClick={() => void startNew()}
              />
            </Box>
          )}
          {onEdit && (
            <HeadBtn
              label={t('office.editRoomInfo')}
              short={t('office.editRoomInfo')}
              icon={<EditOutlinedIcon sx={{ fontSize: 18 }} />}
              iconOnly={iconOnly}
              onClick={onEdit}
            />
          )}
        </Stack>
      </Stack>

      <Box
        role="log"
        aria-label={t('office.meetingLog')}
        aria-live="polite"
        aria-busy={pendingNow.length > 0 || undefined}
        sx={{ flex: 1, minHeight: 0, overflowY: 'auto', px: 2, py: 2 }}
      >
        {/* 답 도착·새 대화 알림. SOUL 변경 알림이 role=status 라 겹치지 않게 역할 없이 aria-live 만 둔다 */}
        <Box aria-live="polite" aria-atomic="true" sx={hiddenSx}>
          {live.text + (live.n % 2 ? ' ' : '')}
        </Box>
        <Box sx={{ maxWidth: chatColumn, mx: 'auto' }}>
          {q.isError && !d && (
            <ErrorRow
              action={
                <Button startIcon={<RefreshIcon />}
                  size="small"
                  variant="outlined"
                  color="inherit"
                  sx={tier2 as object}
                  onClick={() => void q.refetch()}
                >
                  {t('office.meetingRetry')}
                </Button>
              }
            >
              {t('office.meetingLoadFailed', { error: (q.error as Error)?.message ?? '' })}
            </ErrorRow>
          )}
          {d && (
            <MessageList d={d} roomId={roomId} lab={lab} enter={!first.current} retry={retry} askAgain={askAgain} onOpenPrev={(id) => void past.openPast(id)} read={{ conv: readConv, target: readTarget }} />
          )}
          {/* 빈 방 안내는 알림 줄 아래에. 새 대화 직후(차례 > 0)에는 앞 대화를 넘겨받지 않는다는 것을 말한다(DR5·R13) */}
          {d && !talked && !pendingNow.length && (
            <Stack alignItems="center" spacing={1.5} sx={{ mt: 6, textAlign: 'center' }}>
              <Stack direction="row" spacing={-0.5}>
                {participants.slice(0, 5).map((p) => (
                  <AgentAvatar key={p.alias} name={p.alias} label={p.title || p.label || p.alias} size={32} tone="hue" />
                ))}
              </Stack>
              {d.thread ? (
                <>
                  <Typography sx={{ ...small, fontSize: chatType.name }}>{t('office.newThreadEmpty')}</Typography>
                  <Typography sx={{ ...small, fontSize: 12 }}>{t('office.newThreadMemory')}</Typography>
                </>
              ) : (
                <Typography sx={{ ...small, fontSize: chatType.name }}>{t('office.meetingEmpty')}</Typography>
              )}
            </Stack>
          )}
          {d?.pending.map((a) => (
            <Fragment key={`partial:${a}`}>
              <Box sx={{ mt: 2.5 }}>
                <MessageRow
                  side="agent"
                  enter={!first.current}
                  head={{ avatar: <AgentAvatar name={a} label={lab(a)} size={chatMetrics.rowAvatar} tone="hue" />, name: lab(a) }}
                >
                  {/* 차단 안내가 쓰는 중으로 흘러나오면 말풍선 대신 점을 유지한다 — 에이전트가 거절한 것처럼 잠깐 보이지 않게(DD10) */}
                  {d.partial?.[a] && !isGuardBlocked(d.partial[a]) ? (
                    <Markdown text={d.partial[a]} />
                  ) : (
                    <TypingDots label={t('office.agentReplying', { alias: lab(a) })} />
                  )}
                </MessageRow>
              </Box>
            </Fragment>
          ))}
          {/* 정리 전 죽은 서버의 기다림: 입력 중 점 대신 「확인하는 중」. 곧 「받지 못했습니다」 줄로 바뀐다(DR7) */}
          {staleNow.map((a) => (
            <Box key={`stale:${a}`} sx={{ mt: 2.5 }}>
              <MessageRow side="agent" enter={!first.current} head={{ avatar: <AgentAvatar name={a} label={lab(a)} size={chatMetrics.rowAvatar} tone="hue" />, name: lab(a) }}>
                <Typography sx={{ fontSize: chatType.meta, color: tk.muted }}>{t('office.staleChecking', { name: lab(a) })}</Typography>
              </MessageRow>
            </Box>
          ))}
          <div ref={end} />
        </Box>
      </Box>

      <Box sx={{ px: 2, pb: 1.5, pt: 0.5 }}>
        <Box sx={{ maxWidth: chatColumn, mx: 'auto' }}>
          {/* 연결이 끊긴 동안(스펙 2026-10-20-030 4-8·4-10): 입력 칸 바로 위. 5분이 넘으면 빨간 줄로 바꾼다 */}
          {longDown ? (
            <ErrorRow
              action={
                <Button size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={readNow}>
                  {t('office.reconnect.readNow')}
                </Button>
              }
            >
              {t('office.reconnect.meetingDown')}
            </ErrorRow>
          ) : reloading ? (
            <ReconnectRow
              text={t('office.reconnect.meeting')}
              short={t('office.reconnect.short')}
              nextAt={q.errorUpdatedAt ? q.errorUpdatedAt + backoffDelay(Math.max(1, fails.current), { jitter: 0 }) : 0}
              compact={compact}
              action={{ label: t('office.reconnect.readNow'), onClick: readNow }}
            />
          ) : connWait ? (
            <ReconnectRow text={t('chat.reconnect.wait')} short={t('chat.reconnect.waitShort')} compact={compact} />
          ) : null}
          {error && <ErrorRow>{error}</ErrorRow>}
          {threadNote && (
            <Typography role="status" sx={{ ...small, fontSize: 12, pb: 0.5 }}>
              {t('office.threadChangedNote', { name: threadNote })}
            </Typography>
          )}
          {skipped.length > 0 && <SkippedLine skipped={skipped.map((x) => ({ ...x, alias: lab(x.alias) }))} onClose={() => setSkipped([])} />}
          {canAct ? (
            <Composer
              ref={composer}
              value={text}
              onChange={setText}
              onSend={send}
              sendOn="enter"
              compact={compact}
              canSend={!busy && !blockedNet && (!!text.trim() || up.ids.length > 0) && !up.uploading && targets.length > 0}
              inputLabel={t('office.say')}
              sendLabel={t('office.send')}
              placeholder={t('office.sayHintMeeting')}
              describedBy={noRecipient ? reasonId : undefined}
              note={
                blockedNet ? (
                  t('chat.reconnect.note')
                ) : narrow && !mentioned.length ? (
                  // 좁혀진 동안 입력칸 바로 뒤(Tab 순서)에 알리고 「모두에게」로 이번 좁힘만 푼다(DD3·DD13).
                  // 안내 자리(hint)는 떠 있는 창(compact)에서 숨겨지므로 창에서도 보이는 note 자리에 둔다
                  <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.75, maxWidth: '100%' }}>
                    <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>
                      {t('office.narrowHint', { names: narrow.map((a) => '@' + lab(a)).join(' ') })}
                    </Box>
                    <MuiLink
                      component="button"
                      type="button"
                      onClick={() => {
                        setNarrow(null);
                        composer.current?.focus();
                      }}
                      sx={{ fontSize: 'inherit', flexShrink: 0, minHeight: 44, '@media (pointer: fine)': { minHeight: 0 } }}
                    >
                      {t('office.narrowAll')}
                    </MuiLink>
                  </Box>
                ) : chosen ? (
                  <>
                    {t('chat.suggest.willSend', { name: chosen.value })}
                    {missing.length > 0 && (
                      <Box component="span" sx={{ color: AMBER }}>
                        {' '}
                        {t('office.skillMissing', { names: missing.join(', ') })}
                      </Box>
                    )}
                  </>
                ) : undefined
              }
              suggest={[
                {
                  trigger: '@',
                  where: 'word',
                  title: t('office.suggest.agents'),
                  items: agentItems,
                  noMatchText: t('office.suggest.agentsNoMatch'),
                  countText: (n) => t('office.suggest.agentsCount', { count: n }),
                },
                skillSource(meetingSkills, skillItems, {
                  startAt: skillStart,
                  warning: failedNames.length ? t('office.suggest.failed', { names: failedNames.join(', ') }) : undefined,
                }),
              ]}
              hint={
                <>
                  {t('chat.keyHint')}
                  {up.uploading
                    ? ` · ${t('office.meetingFileUploadingHint')}`
                    : filesInfo
                    ? ` · ${t('office.meetingFileLimitHint', {
                        max: humanSize(filesInfo.limits.file),
                        count: filesInfo.max_per_message,
                      })}`
                    : ''}
                  {mentioned.length > 0 &&
                    ` · ${t('office.meetingMentionOnly', { names: mentioned.map((a) => '@' + lab(a)).join(' ') })}`}
                </>
              }
              leading={filesInfo ? <AttachButton onPick={(fs) => up.add(fs)} /> : undefined}
              voice={voice}
              readConv={readConv}
              top={
                <>
                  <Box
                    role="group"
                    aria-label={t('office.meetingTargets')}
                    sx={{
                      display: 'flex',
                      alignItems: 'center',
                      gap: 0.75,
                      overflowX: 'auto',
                      flexWrap: 'nowrap',
                      pb: 0.5,
                    }}
                  >
                    <Typography component="span" sx={{ ...small, flexShrink: 0 }}>
                      {t('office.meetingTargetsShort')}
                    </Typography>
                    {participants.map((p) => (
                      <RecipientChip
                        key={p.alias}
                        p={p}
                        on={p.enabled && (checked.includes(p.alias) || mentioned.includes(p.alias))}
                        dim={mentioned.length > 0 && !mentioned.includes(p.alias)}
                        onToggle={(on) =>
                          // 좁혀진 동안 누른 칩은 이번 말의 받는 사람만 고친다(DD7)
                          narrow
                            ? setNarrow((cur) => (on ? [...(cur ?? []), p.alias] : (cur ?? []).filter((a) => a !== p.alias)))
                            : setSkip((cur) => (on ? cur.filter((a) => a !== p.alias) : [...cur, p.alias]))
                        }
                      />
                    ))}
                    {d && !participants.length && (
                      <Typography component="span" sx={small}>
                        {t('office.noAgents')}
                      </Typography>
                    )}
                    {noRecipient && (
                      <Typography id={reasonId} component="span" sx={{ ...small, flexShrink: 0 }}>
                        {t('office.meetingPickRecipients')}
                      </Typography>
                    )}
                  </Box>
                  {filesInfo && (
                    <UploadChips
                      uploads={up.uploads}
                      info={filesInfo}
                      notice={up.notice}
                      uploading={up.uploading}
                      onRemove={up.remove}
                    />
                  )}
                </>
              }
            />
          ) : (
            <Box
              sx={{
                display: 'flex',
                alignItems: 'center',
                gap: 1,
                px: 1.5,
                py: 1.25,
                border: `1px solid ${tk.line}`,
                borderRadius: `${chatMetrics.panelRadius}px`,
                bgcolor: tk.composer,
                color: tk.muted,
                fontSize: chatType.name,
              }}
            >
              <LockOutlinedIcon aria-hidden="true" sx={{ fontSize: 18 }} />
              <span>{t('office.meetingAdminOnly')}</span>
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

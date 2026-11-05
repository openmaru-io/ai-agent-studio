/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅: 에이전트를 골라 바로 대화. 진행 단계는 접어 두고, 승인·되묻기는 입력창 위에 붙여 둔다.
// 모양은 스펙 2026-10-15-010: 에이전트 답은 상자 없는 기록, 내 말만 단색 판, 입력은 한 카드.
import AddCommentOutlinedIcon from '@mui/icons-material/AddCommentOutlined';
import ArrowBackIcon from '@mui/icons-material/ArrowBack';
import ArrowDownwardIcon from '@mui/icons-material/ArrowDownward';
import AttachFileIcon from '@mui/icons-material/AttachFile';
import CheckIcon from '@mui/icons-material/Check';
import ChevronLeftIcon from '@mui/icons-material/ChevronLeft';
import ContentCopyIcon from '@mui/icons-material/ContentCopy';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import FolderOpenOutlinedIcon from '@mui/icons-material/FolderOpenOutlined';
import HistoryOutlinedIcon from '@mui/icons-material/HistoryOutlined';
import MoreHorizIcon from '@mui/icons-material/MoreHoriz';
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import SendOutlinedIcon from '@mui/icons-material/SendOutlined';
import {
  Alert,
  Box,
  Button,
  CircularProgress,
  Dialog,
  DialogContent,
  DialogTitle,
  IconButton,
  LinearProgress,
  Menu,
  MenuItem,
  Paper,
  Stack,
  TextField,
  type Theme,
  Tooltip,
  Typography,
  useMediaQuery,
  useTheme,
} from '@mui/material';
import { type Ref, useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Link, useLocation, useNavigate, useSearchParams } from 'react-router-dom';

import { ScreenLoading, Tag } from '@/components/bits';
import { ChatFrame } from '@/components/chat/ChatFrame';
import { CommandCard } from '@/components/chat/CommandCard';
import { CommandRows, SlashNote } from '@/components/chat/CommandRows';
import { Composer, ComposerHandle } from '@/components/chat/Composer';
import { ErrorRow } from '@/components/chat/ErrorRow';
import { MessageRow } from '@/components/chat/MessageRow';
import { answerKeys, ReadAloudButton, readPinned, useReadScope, useReadSnap } from '@/components/chat/ReadAloud';
import { ReconnectRow } from '@/components/chat/ReconnectRow';
import { planSlash, skillSuggestItems, slashItems, slashSource } from '@/components/chat/skillSuggest';
import { TypingDots } from '@/components/chat/TypingDots';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { Pill } from '@/components/DataGrid';
import { PageTitle } from '@/components/PageTitle';
import { SubtleBadge } from '@/components/SubtleBadge';
import { teamOwnerName, TeamStatusRow } from '@/components/TeamTargetNote';
import { tier1, tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { useOpenParam, useParamPatch, useRouteDrawerValue } from '@/components/useRouteDrawer';
import { t } from '@/i18n';
import { setCardAreaTop } from '@/lib/cardArea';
import { groupItems, isAsk, pending, Session } from '@/lib/chat';
import { AgentInfo, ChatGroup, ChatStatus, ChatStore, chatStore, groupLabel, rowTitle, SessionRow, singleProfile, targetTitle, useChat } from '@/lib/chatStore';
import { chatColumn, chatColumnPad, chatMetrics, chatType, coarseTouch, hueOf } from '@/lib/chatTokens';
import { useMe } from '@/lib/data';
import { fmtClock, zonedDate } from '@/lib/format';
import { CH } from '@/lib/labels';
import { MONO_FONT } from '@/lib/monoFont';
import { chatTitle } from '@/lib/officeName';
import { FOCUS_RING, gridTokens } from '@/lib/shellTokens';
import { useSkillSuggest } from '@/lib/useSkillSuggest';

import { AnswerMarkdown, FilesBlock, FilesDrawerBody, NoticeLine, PLANS_DIR, UploadRow, UserMessageBody } from './chat/files';
import { AgentStrip, LIMITS, SESSION_STRIP_W, Splitter, STRIP_W, useChatLayout } from './chat/layout';
import { AgentAvatar, ApprovalCard, cancelLine, choiceLabel, ClarifyCard, GuardMark, PastBody, Steps } from './chat/parts';
import { SessionList, SessionStrip, StateMark } from './chat/SessionList';

// 시각은 설정 › 일반의 시간대로 보인다(디자인 리뷰 7-1). 브라우저 로컬 시간을 따로 만들지 않는다.
const hhmm = (ts: number) => fmtClock(ts);

/** 내 말풍선 아래: 시각과 /retry 로 다시 보낸 표시(스펙 2026-10-26-010 DC9). 색 배지 없이 회색 글자 */
function userFoot(ts: number | undefined, retry: boolean | undefined) {
  if (!retry) return ts ? hhmm(ts) : undefined;
  return (
    <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
      {ts ? hhmm(ts) : null}
      {ts ? ' · ' : null}
      <ReplayRoundedIcon aria-hidden="true" sx={{ fontSize: 12 }} />
      {t('chat.cmd.retryMark')}
    </Box>
  );
}

// 부제가 모두 비면 프로파일 이름으로 돌아간다. 프로파일이 하나뿐이면 그 이름(main)을 보이지 않는다(2026-10-19-013 C4)
const agentSub = (a: AgentInfo, hideName = false) =>
  [
    a.running === false ? t('chat.gatewayOff') : a.running ? t('chat.gatewayOn') : '',
    (a.channels ?? []).map((c) => CH[c] || c).join('·'),
    a.description,
  ]
    .filter(Boolean)
    .join(' · ') || (hideName ? '' : a.name);

function agentInfo(store: ChatStore, a: AgentInfo, pod?: string) {
  const S = pod === undefined ? store.sessionOf(a.name) : store.sessionOf(a.name, pod);
  const wait = !!S && pending(S).length > 0;
  let text = a.description || t('chat.noConversation');
  let when = a.last_activity ? Date.parse(a.last_activity) || 0 : 0;
  if (S) {
    const lastMsg = [...S.items].reverse().find((x) => x.kind === 'assistant' || x.kind === 'user');
    if (lastMsg) {
      text = (lastMsg.kind === 'user' ? t('chat.mePrefix') : '') + (lastMsg.text ?? '').replace(/\s+/g, ' ').slice(0, 60);
      when = Math.max(when, lastMsg.t || 0);
    }
    if (S.busy) text = t('chat.replying');
    if (wait) text = t('chat.waitingAnswer');
  }
  return { S, wait, text, when };
}
const whenOf = (ts: number) => {
  if (!ts) return '';
  const d = zonedDate(ts);
  const n = zonedDate(Date.now());
  return d.y === n.y && d.m === n.m && d.d === n.d ? hhmm(ts) : `${d.m}/${d.d}`;
};

const hiddenSx = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

const COLLAPSED_KEY = 'aas-chat-collapsed';
/** 접은 묶음(이 브라우저에만, 디자인 D13). 저장을 못 하면 모두 펼친다 */
function readCollapsed(): string[] {
  try {
    const v = JSON.parse(localStorage.getItem(COLLAPSED_KEY) || '[]');
    return Array.isArray(v) ? v.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}
function writeCollapsed(v: string[]) {
  try {
    localStorage.setItem(COLLAPSED_KEY, JSON.stringify(v));
  } catch {
    /* 저장하지 못해도 이번 화면에서는 접힌 채로 둔다 */
  }
}
/** 아바타·점 색의 기준: 에이전트 이름(없으면 id). 화면에 글자로 보이지 않는다(2026-10-19-013 DD9) */
const colorKeyOf = (g: ChatStatus | ChatGroup | null | undefined, a: AgentInfo) => (g as ChatGroup | undefined)?.name || g?.pod || a.name;

/** 에이전트 줄 하나. pod 가 있으면(묶음 안) 그 에이전트의 프로파일이고, 아바타 색은 에이전트 색을 물려받는다(디자인 D3).
 *  headless: 프로파일이 하나뿐이라 묶음 머리 없이 이 줄이 에이전트를 대신한다(2026-10-19-013) — 이름은 에이전트 이름, 머리에 있던
 *  주인·「지금 에이전트」를 이 줄로 옮기고 낭독 이름에도 넣는다(R3·DD10·DD11). group 은 늘 넘긴다 — 빼면 선택 표시와 여는 대상이 틀린다(C3) */
function AgentRow({ store, a, group, headless, onPicked }: { store: ChatStore; a: AgentInfo; group?: ChatGroup; headless?: boolean; onPicked?: () => void }) {
  const tk = useChatTokens();
  const pick = usePickAgent(store);
  const { S, wait, text, when } = agentInfo(store, a, group?.pod);
  // 이 AI 에이전트에서 살아 있는 세션 수(세션 중심 채팅). 답 필요가 먼저, 다음 실행 중
  const live = store.countsByAgent()[`${group?.pod ?? store.status?.pod ?? ''}|${a.name}`];
  // 묶음이 하나일 때는 group 이 없다 — 이름 규칙은 그 하나뿐인 묶음으로 정한다(DD13)
  const g = group ?? store.group() ?? store.status ?? undefined;
  const one = singleProfile(g);
  const title = rowTitle(g, a);
  const agentName = group && !headless ? groupLabel(group) : '';
  const selected = a.name === store.profile && (!group || group.pod === store.status?.pod);
  // 팀원 에이전트는 지금 에이전트여도(shared 거짓) 이름에 주인을 남긴다(스펙 2026-10-22-001 DD2)
  const owner = headless && (group?.shared || group?.team) ? group.owner_name ?? '' : '';
  return (
    <Box
      component="button"
      type="button"
      data-chat-row={headless ? group?.pod : undefined}
      aria-current={selected}
      aria-label={
        (agentName ? t('chat.chatWithIn', { agent: agentName, name: title }) : t('chat.chatWith', { name: title })) +
        (headless && group?.current ? `, ${t('chat.currentAgent')}` : '') +
        (headless && group?.team ? `, ${t('chat.myTeam')}` : '') +
        (owner ? `, ${t('chat.ownerOf', { name: owner })}` : '') +
        (a.running === false ? `, ${t('chat.gatewayOff')}` : '') +
        (wait ? `, ${t('chat.waitingShort')}` : '') +
        (S?.unread ? `, ${t('chat.unreadAria', { count: S.unread })}` : '')
      }
      onClick={() => {
        pick(a.name, group?.pod);
        onPicked?.();
      }}
      sx={{
        all: 'unset',
        boxSizing: 'border-box',
        display: 'flex',
        gap: 1.5,
        width: '100%',
        minHeight: 60,
        px: 1.5,
        py: 1,
        cursor: 'pointer',
        alignItems: 'center',
        color: tk.text,
        '&:hover': { bgcolor: tk.hover },
        // 선택은 왼쪽 2px 선 + 단색 wash(DESIGN.md §1-1.2). 빨강·파랑을 쓰지 않는다
        '&[aria-current=true]': { bgcolor: tk.selected, boxShadow: `inset 2px 0 0 ${tk.selectedAccent}` },
        '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
        '@media (pointer: coarse)': { minHeight: chatMetrics.touch },
      }}
    >
      <AgentAvatar
        name={colorKeyOf(g, a)}
        label={title}
        tone={group ? 'hue' : 'mono'}
        size={chatMetrics.listAvatar}
        dot={a.running === false ? 'off' : a.running ? 'on' : undefined}
      />
      <Box sx={{ flex: 1, minWidth: 0 }}>
        {/* 순서: 이름 → · 주인 → 지금 에이전트 → 꺼짐. 좁으면 주인부터 줄고(flexShrink 100 : 1) 뱃지·꺼짐은 줄지 않는다(DD10).
            이름에 최소 폭(4em)을 주면 짧은 이름 뒤에 빈칸이 생겨 두지 않는다(가짜 서버 캡처 2026-10-19) */}
        <Box sx={{ display: 'flex', alignItems: 'baseline', gap: 0.5, minWidth: 0, fontSize: chatType.name, fontWeight: 500 }}>
          <Box
            component="span"
            title={one ? t('chat.profileTip', { title, name: a.name }) : title}
            sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', flexShrink: 1, minWidth: 0 }}
          >
            {title}
          </Box>
          {!one && a.title && a.title.toLowerCase() !== a.name ? (
            <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0 }}>
              {' ' + a.name}
            </Typography>
          ) : null}
          {owner ? (
            <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, flexShrink: 100 }} title={t('chat.ownerOf', { name: owner })}>
              {'· ' + owner}
            </Typography>
          ) : null}
          {/* 묶음이 없을 때만 줄에 주인 이름(묶음이 있으면 머리로 옮겼다, 디자인 D3) */}
          {!group && store.status?.owner_name ? (
            <Typography component="span" variant="caption" color="text.secondary" noWrap sx={{ minWidth: 0, flexShrink: 100 }} title={t('chat.ownerOf', { name: store.status.owner_name })}>
              {store.status.owner_name}
            </Typography>
          ) : null}
          {headless && group?.current ? (
            <Box component="span" sx={{ flexShrink: 0, alignSelf: 'center' }}>
              <SubtleBadge>{t('chat.currentAgent')}</SubtleBadge>
            </Box>
          ) : null}
          {headless && group?.team ? (
            <Box component="span" sx={{ flexShrink: 0, alignSelf: 'center' }}>
              <SubtleBadge>{t('chat.myTeam')}</SubtleBadge>
            </Box>
          ) : null}
          {a.running === false ? (
            <Box component="span" sx={{ flexShrink: 0 }}>
              <Tag>{t('chat.off')}</Tag>
            </Box>
          ) : null}
        </Box>
        <Typography variant="body2" noWrap sx={{ color: tk.muted, fontSize: 12 }}>
          {text}
        </Typography>
      </Box>
      <Stack alignItems="flex-end" spacing={0.5}>
        <Typography variant="caption" sx={{ color: tk.muted, fontSize: chatType.meta, fontVariantNumeric: 'tabular-nums' }}>
          {whenOf(when)}
        </Typography>
        {live?.waiting ? (
          <Tag tone="warn">{t('chat.agentLiveWaiting', { n: live.waiting })}</Tag>
        ) : wait ? (
          <Tag tone="warn">{t('chat.check')}</Tag>
        ) : live?.running ? (
          <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, color: tk.muted, fontSize: chatType.meta }}>
            <CircularProgress size={10} thickness={6} sx={{ color: 'info.main' }} aria-hidden />
            {t('chat.agentLiveRunning', { n: live.running })}
          </Box>
        ) : S?.unread ? (
          // 읽지 않은 수는 단색 알약. 초록은 정상 신호에 남긴다(디자인 §1-1)
          <UnreadPill n={S.unread} />
        ) : a.failed_jobs ? (
          <Tag tone="bad">{t('chat.failedCount', { n: a.failed_jobs })}</Tag>
        ) : null}
      </Stack>
    </Box>
  );
}

function UnreadPill({ n }: { n: number }) {
  const tk = useChatTokens();
  return (
    <Box component="span" sx={{ minWidth: 18, px: 0.75, borderRadius: 999, bgcolor: tk.monoTile, color: tk.text, fontSize: chatType.meta, textAlign: 'center' }}>
      {n}
    </Box>
  );
}

/** 묶음 머리 아래의 상태 한 줄(디자인 D7). 연결 없음·멈춤·준비 중 */
function GroupState({ store, g }: { store: ChatStore; g: ChatGroup }) {
  const pad = { px: 1.5, py: 1 };
  if (g.state === 'error')
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={pad}>
        <Pill tone="warn" flush>
          {t('chat.groupOffline')}
        </Pill>
        <Button size="small" onClick={() => void store.refresh()}>
          {t('chat.retry')}
        </Button>
      </Stack>
    );
  if (g.state === 'stopped')
    return (
      <Stack direction="row" spacing={1} alignItems="center" sx={pad}>
        <Tag>{t('agents.phaseSuspended')}</Tag>
        <Link to="/agents">{t('chat.restartAtAgents')}</Link>
      </Stack>
    );
  return (
    <Typography variant="body2" color="text.secondary" role="status" sx={pad}>
      {g.state === 'starting' ? t('chat.groupStarting') : t('common.primaryPreparing', { name: g.primary || 'main' })}
    </Typography>
  );
}

/** 목록에서 에이전트를 고른다 = 그 에이전트로 새 세션(세션 중심 채팅). 다른 세션은 닫지 않고 계속 돈다.
 *  store 를 먼저 바꾼 뒤 주소를 agent·pod 로 쓴다 — 주소 맞추기는 이미 같은 대상이라 아무것도 하지 않는다 */
function usePickAgent(store: ChatStore) {
  const [, setParams] = useSearchParams();
  return (name: string, pod?: string) => {
    // 그 에이전트에 열린 세션이 있으면 그 세션으로 가고, 없을 때만 새 세션을 연다(사용자 결정 D1, 스펙 2026-11-05-005).
    // 새 세션은 「새 세션」 단추로 연다
    const open = store.openSessionFor(name, pod);
    if (open) {
      void store.focus(open.id).then((ok) => {
        if (!ok) return;
        focusComposer();
        const stored = store.current()?.storedId || open.storedId;
        setParams({ agent: open.profile, ...(open.pod ? { pod: open.pod } : {}), ...(stored ? { session: stored } : {}) });
      });
      return;
    }
    void store.startNew(name, pod).then(focusComposer);
    setParams(pod ? { agent: name, pod } : { agent: name });
    focusComposer();
  };
}

/** 세션을 열거나 고른 뒤 바로 칠 수 있게 입력창에 커서를 준다. 같은 AI 에이전트의 새 세션은 대화 칸을 다시 그리지 않아 저절로 가지 않는다 */
function focusComposer() {
  requestAnimationFrame(() => document.querySelector<HTMLTextAreaElement>('[data-guide="chat.composer"] textarea:not([aria-hidden])')?.focus());
}

/** 세션 목록에서 세션을 고른다. 세션을 연 뒤 주소를 그 세션의 agent·pod(·저장 id)로 쓴다 */
function usePickSession(store: ChatStore) {
  const [, setParams] = useSearchParams();
  return async (r: SessionRow) => {
    if (!(await store.focus(r.id))) return;
    focusComposer();
    const S = store.current();
    const stored = S?.storedId || r.storedId;
    setParams({ agent: r.profile, ...(r.pod ? { pod: r.pod } : {}), ...(stored ? { session: stored } : {}) });
  };
}

// 대화를 가리키는 주소 값. panel(「지난 대화」·「파일」 서랍)은 그 대화에 딸려 에이전트를 지울 때 함께 지운다
const LINK_KEYS = ['agent', 'pod', 'session', 'text', 'panel'];
/** panel 을 뺀 검색 값. 서랍만 여닫은 주소 변화인지 본다 */
const withoutPanel = (search: string) => {
  const q = new URLSearchParams(search);
  q.delete('panel');
  return q.toString();
};

/** 채팅 주소(agent·pod·session·text)와 store 를 맞춘다(스펙 2026-10-28-014 §4-2). 주소가 원본이다(D4).
 *  주소→store 는 주소가 바뀐 때(location.key)만 맞춘다. store 가 바뀌었다고 주소에 맞추지 않는다 — 채팅 팝업(chatPopup.ts)이 같은 store 를 바꾼다.
 *  store→주소는 하나뿐이다: 지금 대화의 storedId 가 생기거나 바뀌면 session 을 replace 로 쓴다. 돌려주는 back 은 휴대폰 뒤로 단추다 */
function useChatAddress(store: ChatStore) {
  const location = useLocation();
  const navigate = useNavigate();
  const loc = useRef(location);
  loc.current = location;
  const own = useRef<string | null>(null); // 우리가 replace 로 고쳐 쓴 주소. 이 변화로는 다시 맞추지 않는다
  const syncing = useRef(0); // 주소→store 를 맞추는 중(진행 중 표시, 외부 검토 C1). 이동안은 session 을 쓰지 않는다
  const seq = useRef(0);
  const hadAgent = useRef(false);
  const prevSearch = useRef<string | null>(null);
  const [settled, setSettled] = useState(0);

  const rewrite = useCallback(
    (edit: (p: URLSearchParams) => void) => {
      const p = new URLSearchParams(loc.current.search);
      edit(p);
      const search = p.toString() ? `?${p}` : '';
      if (search === loc.current.search) return;
      own.current = search;
      // 기록 칸의 표시(location.state)는 둔다 — 「지난 대화」·「파일」 서랍을 연 칸이면 닫을 때 되감는다(useOpenParam, D9)
      navigate({ pathname: loc.current.pathname, search }, { replace: true, state: loc.current.state });
    },
    [navigate]
  );

  useEffect(() => {
    const before = prevSearch.current;
    prevSearch.current = location.search;
    const p = new URLSearchParams(location.search);
    const agent = p.get('agent');
    if (own.current === location.search) {
      own.current = null;
      hadAgent.current = !!agent;
      return;
    }
    own.current = null;
    // 「지난 대화」·「파일」 서랍(panel)만 여닫은 변화는 대화를 다시 맞추지 않는다. 새 대화를 시작해 지금 대화가 주소의 session 과
    // 달라도, 서랍을 여닫는다고 주소의 앞 대화로 되돌아가지 않는다(스펙 2026-10-28-014 T7)
    if (before !== null && before !== location.search && withoutPanel(before) === withoutPanel(location.search)) return;
    const n = ++seq.current;
    if (!agent) {
      // 뒤로가기·휴대폰 뒤로 단추로 agent 가 사라졌다 — 목록으로 돌아간다. 처음부터 agent 가 없던 주소는 store 를 건드리지 않는다
      if (hadAgent.current && store.profile) {
        store.profile = '';
        store.currentId = null;
        store.notify();
      }
      hadAgent.current = false;
      return;
    }
    hadAgent.current = true;
    const pod = p.get('pod') || undefined;
    const session = p.get('session');
    const text = p.get('text');
    const stale = () => n !== seq.current;
    syncing.current++;
    void (async () => {
      await store.preload();
      if (stale()) return;
      // 모르는 POD·이름은 열지 않고 알린 뒤 값을 지운다(D5·외부 검토 M5). select 는 모르는 POD 를 지금 묶음으로,
      // known() 은 모르는 이름을 주 에이전트로 조용히 바꾸므로 먼저 본다. 볼 수 있는 묶음은 처음에 모두 읽었으므로 POD 를 옮기지 않는다
      const g = pod ? store.groups.find((x) => x.pod === pod) : undefined;
      const miss = !pod ? '' : !g ? t('chat.linkPodMissing') : g.agents.some((a) => a.name === agent) ? '' : t('chat.linkAgentMissing', { name: agent });
      if (miss) {
        store.notice = miss;
        store.notify();
        rewrite((q) => LINK_KEYS.forEach((k) => q.delete(k)));
        return;
      }
      if (text) {
        // ?text= 는 새 대화를 열고 입력창에 채운다(보내지 않는다). 처리한 뒤 지워, 새로 고쳐도 같은 글로 새 대화를 다시 열지 않는다(외부 검토 H2)
        await store.ask(agent, text, pod);
        if (!stale()) rewrite((q) => q.delete('text'));
        return;
      }
      const S = store.current();
      if (store.profile === agent && (store.status?.pod ?? '') === (pod ?? store.currentPod) && (!session || S?.storedId === session)) return;
      if (!session) return void (await store.openAgent(agent, pod));
      // session 이 있으면 「가장 최근 대화 잇기」를 건너뛰고 그 대화만 연다(외부 검토 C1). 못 열면 안내는 store 가 남기고 session 을 지운다
      if (!(await store.openStored(agent, pod, session)) && !stale()) rewrite((q) => q.delete('session'));
    })().finally(() => {
      syncing.current--;
      setSettled((x) => x + 1);
    });
  }, [location.key, location.search, store, rewrite]);

  const S = store.current();
  const stored = S?.storedId;
  useEffect(() => {
    if (!S || !stored || syncing.current) return;
    const p = new URLSearchParams(location.search);
    // 지금 대화가 주소의 에이전트일 때만 쓴다 — 팝업에서 연 다른 에이전트의 대화 id 를 섞지 않는다(외부 검토 H1)
    if (S.profile !== p.get('agent') || p.get('text') || (S.pod ?? '') !== (p.get('pod') || store.currentPod) || p.get('session') === stored) return;
    rewrite((q) => q.set('session', stored));
  }, [S, stored, settled, location.search, store, rewrite]);

  // 휴대폰 화면의 뒤로 단추: 주소에서 에이전트를 지운다(push, 외부 검토 M3). 주소에 에이전트가 없으면 바뀌는 것이 없으므로 직접 닫는다
  return {
    back: () => {
      const p = new URLSearchParams(loc.current.search);
      if (!p.get('agent')) {
        store.profile = '';
        store.currentId = null;
        store.notify();
        return;
      }
      LINK_KEYS.forEach((k) => p.delete(k));
      navigate({ pathname: loc.current.pathname, search: p.toString() ? `?${p}` : '' });
    },
  };
}

type ChatPanel = 'past' | 'files';
/** 대화의 「지난 대화」·「파일」 서랍을 연다. reveal 은 파일 서랍에서 처음 한 번 펼칠 폴더 */
type OpenPanel = (panel: ChatPanel, reveal?: string) => void;

/** 「지난 대화」·「파일」 서랍을 주소 panel(past·files)과 묶는다(스펙 2026-10-28-014 §4-1, T7).
 *  - 서랍은 주소 agent·pod 의 대화에 딸린다. 그 대화가 열려 있을 때만 연다. 에이전트를 고르면 주소를 새로 쓰고(usePickAgent),
 *    휴대폰 뒤로 단추·열지 못한 링크는 LINK_KEYS 로 지우므로 panel 도 함께 사라진다. 에이전트가 없는 주소의 panel 은 지운다.
 *  - 단추는 useOpenParam(닫혀 있으면 push, 열려 있으면 replace), 닫기는 쌓은 칸이면 되감는다(D9).
 *  - 지난 대화를 고르면 되감지 않고 panel 만 지운다(replace). 되감으면 앞 칸 주소의 session(앞 대화)으로 다시 맞춰 고른 대화가 닫힌다.
 *  - 계획 폴더를 펼쳐 여는 것(reveal)은 주소에 넣지 않는다. 단추를 누를 때 한 번 펴는 보기 상태라, 새로 고치면 처음 상태로 연다 */
function useChatPanel(store: ChatStore): OpenPanel {
  const [params] = useSearchParams();
  const agent = params.get('agent');
  const pod = params.get('pod') || '';
  const panel = params.get('panel');
  const patch = useParamPatch();
  const write = useOpenParam('panel');
  const reveal = useRef<string | undefined>(undefined);
  // 이미 연 파일 서랍에서 계획 폴더 단추를 다시 누르면 본문을 새로 만들어 다시 편다(전에는 서랍을 새로 열었다)
  const [revealSeq, setRevealSeq] = useState(0);
  const here = !!agent && store.profile === agent && (store.status?.pod ?? '') === (pod || store.currentPod);
  const value = here && (panel === 'past' || (panel === 'files' && store.filesEnabled)) ? panel : null;

  useRouteDrawerValue(
    'panel',
    value,
    (v) => {
      const title = targetTitle(store.group() ?? store.status, store.agent(store.profile), store.groups.length > 1);
      if (v === 'past')
        return {
          title: t('chat.pastTitle'),
          sub: t('chat.pastSub', { title }),
          body: <PastBody store={store} profile={store.profile} onPicked={() => patch({ panel: null }, { replace: true })} />,
        };
      const at = reveal.current;
      reveal.current = undefined;
      return { title: t('chat.files.drawerTitle'), sub: title, body: <FilesDrawerBody key={revealSeq} store={store} reveal={at} /> };
    },
    [],
    [revealSeq],
    [agent, pod]
  );

  useEffect(() => {
    if (!agent && panel) patch({ panel: null }, { replace: true });
  }, [agent, panel, patch]);

  return useCallback(
    (p: ChatPanel, at?: string) => {
      reveal.current = at;
      if (at) setRevealSeq((n) => n + 1);
      write({ panel: p });
    },
    [write]
  );
}

function AgentList({
  store,
  onPicked,
  searchRef,
}: {
  store: ChatStore;
  onPicked?: () => void;
  /** 「새 세션」이 커서를 줄 검색칸 */
  searchRef?: Ref<HTMLInputElement>;
}) {
  const [q, setQ] = useState('');
  const [collapsed, setCollapsed] = useState<string[]>(readCollapsed);
  const primary = useMe().data?.primary;
  const tk = useChatTokens();
  const mode = useTheme().palette.mode;
  const gt = gridTokens[mode];
  const needle = q.trim().toLowerCase();
  const groups = store.groups;
  const multi = groups.length > 1;
  const preparing = groups.some((g) => g.state === 'starting' || (g.primary_ready === false && !g.agents.length));

  // 준비 중인 묶음이 있는 동안만 15초마다, 그리고 창을 다시 볼 때 묶음을 다시 읽는다(디자인 D8)
  useEffect(() => {
    if (!preparing) return;
    const timer = window.setInterval(() => void store.refresh(), 15000);
    const onFocus = () => void store.refresh();
    window.addEventListener('focus', onFocus);
    return () => {
      window.clearInterval(timer);
      window.removeEventListener('focus', onFocus);
    };
  }, [preparing, store]);

  // 줄이 에이전트 이름을 보이면(프로파일 1개) 그 이름으로도 찾는다(2026-10-19-013 C2)
  const rowsOf = (agents: AgentInfo[], groupHit: boolean, pod?: string) =>
    agents
      .filter(
        (a) =>
          groupHit ||
          !needle ||
          (a.name + ' ' + (a.title ?? '') + ' ' + (a.description ?? '') + ' ' + rowTitle(store.group(pod) ?? store.status, a)).toLowerCase().includes(needle)
      )
      .map((a) => ({ a, ...agentInfo(store, a, pod) }))
      .sort((x, y) => Number(y.wait) - Number(x.wait) || y.when - x.when || x.a.name.localeCompare(y.a.name));

  // 머리 없는 줄(프로파일 1개)은 접히지 않는다. 머리가 있던 때 접어 둔 기억은 지운다 — 2개가 되면 접힌 채 나타나던 것(DC1)
  const headless = groups.length > 1 ? groups.filter((g) => singleProfile(g)).map((g) => g.pod ?? '') : [];
  const headlessKey = headless.join('|');
  useEffect(() => {
    const keep = collapsed.filter((p) => !headless.includes(p));
    if (keep.length !== collapsed.length) {
      setCollapsed(keep);
      writeCollapsed(keep);
    }
  }, [headlessKey]); // eslint-disable-line react-hooks/exhaustive-deps
  // 준비 중이던 묶음의 머리에 포커스가 있었는데 머리가 사라지면(프로파일 1개가 됨) 그 에이전트 줄로 옮긴다(DD4)
  const focusedHead = useRef('');
  useEffect(() => {
    const pod = focusedHead.current;
    if (pod && headless.includes(pod) && (!document.activeElement || document.activeElement === document.body)) {
      document.querySelector<HTMLElement>(`[data-chat-row="${CSS.escape(pod)}"]`)?.focus();
      focusedHead.current = '';
    }
  }, [headlessKey]); // eslint-disable-line react-hooks/exhaustive-deps

  const toggle = (pod: string) => {
    const next = collapsed.includes(pod) ? collapsed.filter((x) => x !== pod) : [...collapsed, pod];
    setCollapsed(next);
    writeCollapsed(next);
  };

  // 묶음 하나: 지금 모양 그대로(묶음 머리 없음)
  const single = !multi ? rowsOf(store.status?.agents ?? [], false) : [];
  // 여러 묶음: 묶음 이름·주인 이름이 맞으면 그 묶음의 줄을 모두 보이고, 결과가 0 인 묶음은 숨긴다(디자인 D14)
  const shown = multi
    ? groups
        .map((g) => {
          const hit = !!needle && (groupLabel(g) + ' ' + (g.shared || g.team ? g.owner_name ?? '' : '')).toLowerCase().includes(needle);
          return { g, hit, rows: rowsOf(g.agents, hit, g.pod) };
        })
        .filter(({ hit, rows }) => !needle || hit || rows.length > 0)
    : [];
  const empty = multi ? !shown.length : !single.length;

  return (
    <Box
      component="aside"
      aria-label={t('chat.agentsLabel')}
      data-guide="chat.agents"
      sx={{ bgcolor: tk.rail, overflow: 'auto', minHeight: 0, flex: 1 }}
    >
      <Box sx={{ p: 1.5 }}>
        <TextField
          size="small"
          fullWidth
          type="search"
          placeholder={t('chat.findAgentPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          inputRef={searchRef}
          slotProps={{ htmlInput: { 'aria-label': t('chat.findAgentLabel'), 'data-view-search': '' } }}
          // 움푹한 검색 입력(DESIGN.md §1-1.2 Sunken input): 공통 표 검색 칸과 같은 토큰
          sx={{
            '& .MuiOutlinedInput-root': { bgcolor: gt.searchBg, fontSize: chatType.name, '& fieldset': { borderColor: gt.searchLine } },
            '& .MuiOutlinedInput-root.Mui-focused fieldset, & .MuiOutlinedInput-root:hover fieldset': { borderColor: gt.searchFocus },
          }}
        />
      </Box>
      {!multi && store.status?.error && (
        <Alert severity="warning" sx={{ mx: 1.5, mb: 1 }}>
          {store.status.error}
        </Alert>
      )}
      <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
        {!multi &&
          single.map(({ a }) => (
            <li key={a.name}>
              <AgentRow store={store} a={a} onPicked={onPicked} />
            </li>
          ))}
        {shown.map(({ g, rows }) => {
          const pod = g.pod ?? '';
          // 프로파일이 하나뿐이면 묶음 머리 없이 에이전트 줄 하나. 위 선과 4px 여백이 머리 대신 에이전트 사이를 나눈다(2026-10-19-013 R1·R4·DD1)
          if (singleProfile(g))
            return rows.length ? (
              <li key={pod} style={{ borderTop: `1px solid ${tk.line}`, paddingTop: 4 }}>
                <AgentRow store={store} a={rows[0].a} group={g} headless onPicked={onPicked} />
              </li>
            ) : null;
          const open = !!needle || !collapsed.includes(pod) || pod === store.status?.pod;
          const unread = rows.reduce((n, r) => n + (r.S?.unread ?? 0), 0);
          const waits = rows.filter((r) => r.wait).length;
          const hid = `chat-group-${pod}`;
          const label = groupLabel(g);
          return (
            <li key={pod} role="group" aria-labelledby={hid}>
              <Box
                component="button"
                type="button"
                id={hid}
                aria-expanded={open}
                onClick={() => toggle(pod)}
                onFocus={() => (focusedHead.current = pod)}
                onBlur={() => (focusedHead.current = '')}
                sx={{
                  all: 'unset',
                  boxSizing: 'border-box',
                  position: 'sticky',
                  top: 0,
                  zIndex: 1,
                  display: 'flex',
                  alignItems: 'center',
                  gap: 0.75,
                  width: '100%',
                  height: 32,
                  px: 1.5,
                  cursor: 'pointer',
                  bgcolor: tk.rail,
                  borderTop: `1px solid ${tk.line}`,
                  color: tk.muted,
                  fontSize: chatType.meta,
                  fontWeight: 600,
                  '&:hover': { color: tk.text },
                  '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: -2 },
                }}
              >
                <ExpandMoreIcon aria-hidden sx={{ fontSize: 16, transition: 'transform .15s', transform: open ? 'none' : 'rotate(-90deg)' }} />
                <Box component="span" aria-hidden sx={{ width: 8, height: 8, borderRadius: '50%', flexShrink: 0, bgcolor: hueOf(g.name || pod) }} />
                {/* 에이전트 이름은 머리 없는 줄의 이름과 같은 13px(DD2). 주인·뱃지는 meta 크기 그대로 */}
                <Box component="span" title={label} sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: tk.text, fontSize: chatType.name }}>
                  {label}
                </Box>
                {/* 팀원 에이전트도 이름은 「에이전트 · 주인」 그대로이고 머리에 「내 팀」만 더한다(스펙 2026-10-22-001 DD2) */}
                {(g.shared || g.team) && g.owner_name ? (
                  <Box component="span" sx={{ whiteSpace: 'nowrap' }} title={t('chat.ownerOf', { name: g.owner_name })}>
                    {'· ' + g.owner_name}
                  </Box>
                ) : null}
                {g.current ? <SubtleBadge>{t('chat.currentAgent')}</SubtleBadge> : null}
                {g.team ? <SubtleBadge>{t('chat.myTeam')}</SubtleBadge> : null}
                <Box sx={{ flex: 1 }} />
                {/* 접힌 머리에는 그 묶음의 확인 필요·읽지 않은 수(디자인 D13) */}
                {!open && waits ? <Tag tone="warn">{t('chat.check')}</Tag> : null}
                {!open && unread ? <UnreadPill n={unread} /> : null}
              </Box>
              {open && (
                <Box component="ul" sx={{ listStyle: 'none', m: 0, p: 0 }}>
                  {g.state && g.state !== 'ok' ? (
                    <li>
                      <GroupState store={store} g={g} />
                    </li>
                  ) : !g.agents.length && g.primary_ready === false ? (
                    <li>
                      <GroupState store={store} g={g} />
                    </li>
                  ) : (
                    rows.map(({ a }) => (
                      <li key={a.name}>
                        <AgentRow store={store} a={a} group={g} onPicked={onPicked} />
                      </li>
                    ))
                  )}
                </Box>
              )}
            </li>
          );
        })}
        {empty && (
          <li>
            <Typography color="text.secondary" sx={{ p: 2 }} role={!needle && primary?.ready === false ? 'status' : undefined}>
              {/* 「+」로 만든 직후 주 프로파일(main)을 만드는 동안(2026-10-19-001 D7·D9). 끝나면 AppShell 이 목록을 다시 읽는다 */}
              {!needle && primary?.ready === false ? t('common.primaryPreparing', { name: primary.profile }) : t('chat.noAgents')}
            </Typography>
          </li>
        )}
      </Box>
    </Box>
  );
}

function Messages({ S, store, profile, onPanel }: { S: Session | null; store: ChatStore; profile: string; onPanel: OpenPanel }) {
  const tk = useChatTokens();
  const box = useRef<HTMLDivElement>(null);
  const stick = useRef(true);
  const first = useRef(true);
  const [away, setAway] = useState(false);
  const [open, setOpen] = useState<Record<string, boolean>>({});
  const [copied, setCopied] = useState<number | null>(null);
  const [live, setLive] = useState({ n: 0, text: '' });
  const prev = useRef<{ id?: string; busy: boolean }>({ busy: false });
  // 답한 사람: 프로파일이 하나뿐이면 에이전트 이름, 아바타 글자·색도 목록과 같다(2026-10-19-013 DD8·DD9)
  const g = store.group() ?? store.status;
  const me = store.agent(profile);
  const title = rowTitle(g, me);
  const color = colorKeyOf(g, me);
  // 답 「읽어 주기」(스펙 2026-10-28-012 §3-9): 대화 상대의 에이전트·프로파일로 읽는다. 상태 키는 (대화, 답 글의 고유값)이다(F11)
  const rs = useReadSnap();
  const readConv = conversationKey(S);
  useReadScope(readConv);
  const readTarget = profile ? { pod: store.status?.pod, profile, tts: g?.tts, voices: g?.tts_voices } : undefined;
  const answers = S ? S.items.filter((x) => x.kind === 'assistant') : [];
  const answerKey = new Map(answerKeys(answers.map((x) => x.text ?? '')).map((k, j) => [answers[j], k]));
  const writing = S?.busy ? answers[answers.length - 1] : undefined;
  // /plan 턴의 마지막 답(스펙 2026-10-26-010 DC10): 아래에 「계획 파일 열기」 — 계획은 작업 폴더의 .hermes/plans/ 에 생긴다
  const planAnswers = new Set<number>();
  if (S && store.filesEnabled) {
    let inPlan = false;
    let lastAnswer = -1;
    S.items.forEach((x, k) => {
      if (x.kind === 'user') {
        if (inPlan && lastAnswer >= 0) planAnswers.add(lastAnswer);
        inPlan = /^\/plan(\s|$)/.test(x.text ?? '');
        lastAnswer = -1;
      } else if (x.kind === 'assistant') lastAnswer = k;
    });
    if (inPlan && lastAnswer >= 0 && !S.busy) planAnswers.add(lastAnswer);
  }
  const atBottom = () =>
    !box.current || box.current.scrollHeight - box.current.scrollTop - box.current.clientHeight < 80;

  useLayoutEffect(() => {
    if (stick.current && box.current) {
      box.current.scrollTop = box.current.scrollHeight;
      if (S) S.seen = S.items.length;
    }
  });
  useEffect(() => {
    first.current = false; // 처음 그린 뒤에 붙는 행만 120ms 전환을 쓴다
  }, []);

  // 스트리밍 중에는 읽지 않고(aria-busy), 답이 끝나면 한 번만 알린다(디자인 리뷰 6-2)
  const busy = !!S?.busy;
  // 렌더마다 직전 busy 와 견주는 것이 의도라 의존성 목록을 두지 않는다
  // eslint-disable-next-line react-hooks/exhaustive-deps
  useEffect(() => {
    if (S && prev.current.id === S.id && prev.current.busy && !busy) {
      const last = [...S.items].reverse().find((x) => x.kind === 'assistant' || x.kind === 'error');
      if (last?.kind === 'assistant') setLive((l) => ({ n: l.n + 1, text: t('chat.replyArrived', { name: title }) }));
    }
    prev.current = { id: S?.id, busy };
  });

  // 지난 이벤트를 따라잡는 동안은 반쯤 쌓인 대화를 그리지 않는다 — 다른 세션 때문에 다시 그려져도 끝난 뒤 한 번에 보인다
  const catching = !!S?.catchUp;
  const blocks = S && !catching ? groupItems(S) : [];
  // 안전장치가 막은 단계 바로 뒤의 첫 에이전트 답에 빨간 표시(스펙 2026-10-24-004). 사용자 글이 오면 끊는다
  const guardOf: Record<number, string> = {};
  {
    let carry = '';
    blocks.forEach((b, i) => {
      if (b.type === 'steps') carry = b.items.find((x) => x.guard)?.guard ?? carry;
      else if (b.type === 'item' && b.item.kind === 'user') carry = '';
      else if (b.type === 'item' && b.item.kind === 'assistant' && carry) {
        guardOf[i] = carry;
        carry = '';
      }
    });
  }
  const resend = (it: { text?: string; retry?: string; retryFiles?: string[]; retrySkill?: string }) => {
    const again = it.retry as string;
    it.retry = '';
    it.text += ' ' + t('chat.resent');
    store.notify();
    store.send(again, it.retryFiles ?? undefined, it.retrySkill);   // 파일을 붙인 메시지는 첨부도 함께 다시 보낸다(D21). 스킬도 그대로
  };
  const copy = async (text: string, i: number) => {
    try {
      await navigator.clipboard.writeText(text);
      setCopied(i);
      setLive((l) => ({ n: l.n + 1, text: t('chat.copiedLive') }));
      window.setTimeout(() => setCopied((c) => (c === i ? null : c)), 1500);
    } catch {
      /* 복사하지 못해도 대화는 계속된다. 확인 아이콘이 안 바뀌어 복사가 안 된 것을 알 수 있다 */
    }
  };
  const small = { fontSize: 12, color: tk.muted } as const;

  return (
    <Box sx={{ position: 'relative', flex: 1, minHeight: 0, display: 'flex' }}>
      <Box
        ref={box}
        role="log"
        aria-live="polite"
        aria-busy={busy || undefined}
        aria-label={t('chat.logLabel')}
        onScroll={() => {
          const b = atBottom();
          stick.current = b;
          setAway(!b);
        }}
        sx={{ flex: 1, overflow: 'auto', px: 2, py: 2 }}
      >
        {/* 화면 읽기 프로그램용 알림: 복사·답 도착. 내용은 다시 읽지 않는다 */}
        <Box role="status" sx={hiddenSx}>
          {live.text + (live.n % 2 ? ' ' : '')}
        </Box>
        <Box sx={{ maxWidth: chatColumn, mx: 'auto' }}>
          {(!S || catching) && (
            <Stack alignItems="center" spacing={1.5} sx={{ mt: 6 }}>
              <AgentAvatar name={color} label={title} size={chatMetrics.emptyAvatar} />
              <Typography sx={{ fontWeight: 700 }}>{title}</Typography>
              <Typography sx={{ ...small, fontSize: chatType.name }} align="center">
                {store.opening || catching ? t('chat.loadingPast') : t('chat.startHint')}
              </Typography>
            </Stack>
          )}
          {blocks.map((b, i) => {
            if (b.type === 'day')
              return (
                <Box key={i} sx={{ display: 'flex', justifyContent: 'center', my: 2 }}>
                  <Box
                    component="span"
                    sx={{ px: 1.5, py: 0.25, borderRadius: 999, bgcolor: tk.rail, border: `1px solid ${tk.line}`, fontSize: chatType.meta, color: tk.muted }}
                  >
                    {b.text}
                  </Box>
                </Box>
              );
            if (b.type === 'working')
              return (
                <Box key={i} sx={{ ml: 5, my: 1 }}>
                  <TypingDots label={t('chat.working')} />
                </Box>
              );
            if (b.type === 'steps') {
              const key = `${S?.id}:${b.idx}`;
              return (
                <Box key={i} sx={{ ml: 5 }}>
                  <Steps
                    items={b.items}
                    live={b.live}
                    open={open[key] ?? b.attach}
                    onToggle={() => setOpen((o) => ({ ...o, [key]: !(o[key] ?? b.attach) }))}
                  />
                </Box>
              );
            }
            const it = b.item;
            const gap = { mt: b.cont ? 0.5 : 2.5 };
            if (it.kind === 'user')
              return (
                <Box key={i} sx={gap}>
                  <MessageRow side="mine" enter={!first.current} foot={userFoot(it.t, it.retried)}>
                    <UserMessageBody text={it.text ?? ''} files={it.files} store={store} />
                  </MessageRow>
                </Box>
              );
            if (it.kind === 'assistant') {
              const rk = answerKey.get(it) ?? '';
              return (
                <Box key={i} sx={gap}>
                  <MessageRow
                    side="agent"
                    enter={!first.current}
                    pinActions={readPinned(rs, readConv, rk)}
                    head={
                      b.cont
                        ? undefined
                        : { avatar: <AgentAvatar name={color} label={title} size={chatMetrics.rowAvatar} />, name: title, time: it.t ? hhmm(it.t) : undefined }
                    }
                    actions={
                      <>
                        <Tooltip title={t('chat.copyReplyLabel')}>
                          <IconButton
                            size="small"
                            aria-label={t('chat.copyReplyLabel')}
                            onClick={() => copy(it.text ?? '', i)}
                            sx={{ color: tk.muted, '&:hover': { color: tk.text }, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } }}
                          >
                            {copied === i ? <CheckIcon sx={{ fontSize: 16 }} /> : <ContentCopyIcon sx={{ fontSize: 16 }} />}
                          </IconButton>
                        </Tooltip>
                        <ReadAloudButton target={readTarget} conv={readConv} msg={rk} name={title} text={it.text ?? ''} streaming={it === writing} />
                      </>
                    }
                  >
                    {guardOf[i] ? <GuardMark reason={guardOf[i]} /> : null}
                    <AnswerMarkdown text={it.text ?? ''} store={store} />
                    {planAnswers.has(S?.items.indexOf(it) ?? -1) && (
                      <Button
                        size="small"
                        color="inherit"
                        startIcon={<FolderOpenOutlinedIcon sx={{ fontSize: 16 }} />}
                        onClick={() => onPanel('files', PLANS_DIR)} // 계획 폴더를 펼쳐 연다(스펙 2026-10-27-012 §4-9)
                        sx={[{ mt: 0.5, px: 0.75, fontSize: chatType.meta, color: tk.muted }, coarseTouch]}
                      >
                        {t('chat.cmd.planFile')}
                      </Button>
                    )}
                  </MessageRow>
                </Box>
              );
            }
            if (it.kind === 'error')
              return (
                <ErrorRow
                  key={i}
                  inset
                  action={
                    it.retry ? (
                      <Button startIcon={<SendOutlinedIcon />} size="small" variant="outlined" color="inherit" sx={tier2 as object} onClick={() => resend(it)}>
                        {t('chat.resend')}
                      </Button>
                    ) : it.reopen && S?.closed && !S.reconnect ? (
                      // 끊긴 대화: 팝업에는 에이전트 목록이 없어 「에이전트를 다시 누르라」는 안내를 따를 수 없었다. 누르면 한도를 새로 시작한다(DR10)
                      <Button size="small" variant="outlined" color="inherit" sx={[tier2 as object, coarseTouch]} onClick={() => void store.reopen()}>
                        {t('chat.reopen')}
                      </Button>
                    ) : it.newChat && S?.closed && !S.reconnect ? (
                      // Hermes 에서 대화를 찾지 못했다 — 다시 열어도 같으므로 새 대화로(DR4)
                      <Button size="small" variant="outlined" color="inherit" sx={[tier2 as object, coarseTouch]} onClick={() => void store.newChat()}>
                        {t('chat.newChatShort')}
                      </Button>
                    ) : undefined
                  }
                >
                  {it.text}
                </ErrorRow>
              );
            if (it.kind === 'files') return <FilesBlock key={i} item={it} store={store} />;
            if (it.kind === 'command')
              return <CommandCard key={i} command={it.command ?? ''} text={it.text ?? ''} time={it.t ? hhmm(it.t) : undefined} background={it.background} />;
            if (it.kind === 'notice' && it.code === 'rewind_failed')
              // 되감은 뒤 기록을 못 읽었다(11-3) — 할 일이 없어 회색. 다시 열면 맞춰진다
              return (
                <Box key={i} role="note" sx={{ my: 1, textAlign: 'center', fontSize: chatType.meta, color: tk.muted }}>
                  {t('chat.files.notice.rewind_failed')}
                </Box>
              );
            if (it.kind === 'notice') return <NoticeLine key={i} code={it.code} name={it.name} reason={it.reason} text={it.text} />;
            if (it.kind === 'divider')
              // 지난 대화 경계: 선 + 글자, 아래 둘째 줄 안내(스펙 §4-3). 장식 대시(—)는 쓰지 않는다
              return (
                <Box key={i} sx={{ my: 2, color: tk.muted, textAlign: 'center', fontSize: chatType.meta }}>
                  <Box sx={{ display: 'flex', alignItems: 'center', gap: 1.5 }}>
                    <Box sx={{ flex: 1, height: '1px', bgcolor: tk.line }} />
                    <span>{it.text}</span>
                    <Box sx={{ flex: 1, height: '1px', bgcolor: tk.line }} />
                  </Box>
                  {it.hint && <Box sx={{ mt: 0.5 }}>{it.hint}</Box>}
                  {it.code === 'past' && store.filesEnabled && <Box sx={{ mt: 0.25 }}>{t('chat.files.pastHint')}</Box>}
                </Box>
              );
            if (it.kind === 'approval' && it.answered)
              return (
                <Typography key={i} variant="body2" sx={{ ...small, my: 1, ml: 5 }}>
                  {t('chat.approvalAnswered', { choice: choiceLabel(it.answered) })}
                  <code>
                    {String(
                      (it.p as Record<string, unknown>)?.command ||
                        (it.p as Record<string, unknown>)?.cmd ||
                        (it.p as Record<string, unknown>)?.description ||
                        ''
                    ).slice(0, 160)}
                  </code>
                </Typography>
              );
            if (it.kind === 'clarify' && it.answered)
              return (
                <Typography key={i} variant="body2" sx={{ ...small, my: 1, ml: 5 }}>
                  {t('chat.clarifyAnswered', { question: it.question || '', answer: String(it.answered) })}
                </Typography>
              );
            if ((it.kind === 'approval' || it.kind === 'clarify') && it.cancelled)
              // 취소로 닫힌 카드: 요청이 온 자리의 줄을 바꾼다(토스트 아님). 답한 줄과 같은 작은 회색 글자(디자인 D3·D7)
              return (
                <Typography key={i} variant="body2" sx={{ ...small, my: 1, ml: 5 }}>
                  {cancelLine(it)}
                  {it.kind === 'approval' && (
                    <>
                      {' · '}
                      <code>{String((it.p as Record<string, unknown>)?.command || (it.p as Record<string, unknown>)?.description || '').slice(0, 160)}</code>
                    </>
                  )}
                </Typography>
              );
            if (it.kind === 'approval' || it.kind === 'clarify') {
              // 답하지 않은 요청이 연달아 있으면 첫 줄만 보인다 — 요청 수만큼 같은 문장이 되풀이되던 것(R10)
              const before = blocks[i - 1];
              if (before?.type === 'item' && isAsk(before.item)) return null;
              return (
                <Typography key={i} variant="caption" align="center" component="div" sx={{ ...small, my: 1 }}>
                  {t('chat.waitingBelow')}
                </Typography>
              );
            }
            return null;
          })}
        </Box>
      </Box>
      {away && S && (
        <Button
          size="small"
          variant="outlined"
          color="inherit"
          startIcon={<ArrowDownwardIcon sx={{ fontSize: 16 }} />}
          onClick={() => {
            if (box.current) box.current.scrollTop = box.current.scrollHeight;
          }}
          sx={[
            tier1 as object,
            // tier1 의 바탕은 반투명 wash 라 뒤의 본문 글자가 비쳤다. 대화 바탕색(불투명) 위에 같은 wash 를 한 겹 얹는다.
            (th: Theme) => {
              const dark = th.palette.mode === 'dark';
              const layer = (a: number) => {
                const c = dark ? `rgba(255,255,255,${a})` : `rgba(17,24,39,${a})`;
                return { backgroundColor: tk.canvas, backgroundImage: `linear-gradient(${c}, ${c})` };
              };
              return {
                position: 'absolute',
                left: '50%',
                transform: 'translateX(-50%)',
                bottom: 12,
                zIndex: 1,
                borderRadius: 999,
                ...layer(dark ? 0.06 : 0.05),
                boxShadow: dark ? '0 2px 10px rgba(0,0,0,0.5)' : '0 2px 10px rgba(17,24,39,0.16)',
                '&:hover': layer(dark ? 0.12 : 0.1),
              };
            },
          ]}
        >
          {S.items.length > S.seen ? t('chat.newMessages') : t('chat.toBottom')}
        </Button>
      )}
    </Box>
  );
}

/** 대화 객체마다 붙이는 번호. 다시 연결하며 세션 id 가 바뀌어도(adopt) 같은 객체라 번호가 같다 — id 로 비교하면 그때 녹음이 버려진다 */
const convIds = new WeakMap<object, string>();
let convSeq = 0;
function conversationKey(S: object | null): string {
  if (!S) return '';
  let k = convIds.get(S);
  if (!k) convIds.set(S, (k = String(++convSeq)));
  return k;
}

/** 대화 하나(머리·메시지·입력). 채팅 화면과 대화 팝업(OMAI-1115)이 함께 쓴다. onBack 이 없으면 뒤로 단추를 두지 않는다. compact 는 팝업: 단추 글자와 키 안내를 숨긴다.
 *  onPanel 은 채팅 화면이 「지난 대화」·「파일」 서랍을 주소로 열 때 준다(useChatPanel). 없으면(팝업) 주소 없이 바로 연다 */
export function Conversation({ store, onBack, compact, onPanel }: { store: ChatStore; onBack?: () => void; compact?: boolean; onPanel?: OpenPanel }) {
  const tk = useChatTokens();
  const profile = store.profile;
  const a = store.agent(profile);
  const S = store.current();
  const { openDrawer } = useUi();
  const [input, setInput] = useState(store.draft);
  // 세션마다 쓰던 글을 따로 둔다. 같은 에이전트의 다른 세션으로 옮기면 쓰던 글을 그 세션 몫으로 두고 옮겨 간 세션의 글을 꺼낸다
  const inputNow = useRef(input);
  inputNow.current = input;
  const shownId = useRef<string | null>(store.currentId);
  const curId = store.currentId;
  const mountedAt = useRef({ pod: store.status?.pod, profile });
  useEffect(() => {
    const prev = shownId.current;
    shownId.current = curId;
    if (prev === curId || (prev === null && curId !== null && !store.sessions[curId]?.items.length)) return; // 새 세션의 첫 보내기는 같은 대화다
    store.stashDraft(prev, mountedAt.current.pod, mountedAt.current.profile, inputNow.current);
    setInput(store.draft);
  }, [curId]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => () => store.stashDraft(shownId.current, mountedAt.current.pod, mountedAt.current.profile, inputNow.current), [store]);
  const [anchor, setAnchor] = useState<HTMLElement | null>(null);
  const items = pending(S);
  // 에이전트가 여럿이면 머리에 「에이전트 / 프로파일」 — 보내기는 되돌릴 수 없어 대상이 보여야 한다(2026-10-19-001 디자인 D4).
  // 프로파일이 하나뿐이면 대상도 하나라 에이전트 이름만(2026-10-19-013). 에이전트 id 는 보이지 않는다(R2)
  const g = store.group() ?? store.status;
  const one = singleProfile(g);
  const title = targetTitle(g, a, store.groups.length > 1);
  const busy = !!S?.busy;
  const iconOnly = useMediaQuery(useTheme().breakpoints.down('lg')) || !!compact;
  // 연결이 끊긴 동안(스펙 2026-10-20-030 4-10): 입력 칸 위 줄, 보내기·멈춤 막기, 상태가 바뀔 때만 알림
  const view = store.reconnectView(S);
  const blocked = store.blocked(S);
  const rowFocus = useRef(false);
  // 보낼 대상이 팀원 에이전트면 입력 칸 위에 누구의 에이전트인지 회색 줄로 알린다. 기준은 쿠키가 아니라 이 대화의 묶음이다(스펙 2026-10-22-001 DD5)
  const target = store.group();
  const teamOwner = target?.team ? teamOwnerName({ owner_name: target.owner_name, id: target.pod }) : '';

  const picker = useRef<HTMLInputElement>(null);
  const composer = useRef<ComposerHandle>(null);
  const [dragging, setDragging] = useState(false);
  const files = store.filesEnabled;
  // 「지난 대화」·「파일」 서랍. 채팅 화면은 주소로 연다(onPanel), 팝업은 바로 연다
  const panel: OpenPanel = (p, reveal) =>
    onPanel
      ? onPanel(p, reveal)
      : openDrawer(
          p === 'past'
            ? { title: t('chat.pastTitle'), sub: t('chat.pastSub', { title }), body: <PastBody store={store} profile={profile} /> }
            : { title: t('chat.files.drawerTitle'), sub: title, body: <FilesDrawerBody store={store} reveal={reveal} /> }
        );
  const uploading = store.uploading();
  const refocus = () => composer.current?.focus();
  // 승인·되묻기 카드 묶음(디자인 D8~D10): 높이 50dvh 까지 안에서 스크롤, 주소로 연 화면만 위 끝을 캐릭터에 알린다(재리뷰 R20)
  const cards = useRef<HTMLDivElement>(null);
  const cardFocus = useRef(false);
  const cancelN = S?.cancelN ?? 0;
  const lastCancelled = S ? [...S.items].reverse().find((x) => x.cancelled) : undefined;
  useEffect(() => {
    if (compact) return;
    const el = cards.current;
    if (!el) return;
    const tell = () => setCardAreaTop(items.length ? el.getBoundingClientRect().top : null);
    tell();
    const ro = typeof ResizeObserver === 'undefined' ? null : new ResizeObserver(tell);
    ro?.observe(el);
    window.addEventListener('resize', tell);
    return () => {
      ro?.disconnect();
      window.removeEventListener('resize', tell);
    };
  }, [compact, items.length]);
  useEffect(() => () => {
    if (!compact) setCardAreaTop(null);
  }, [compact]);
  // 새 카드가 오면 그 카드가 보이게 묶음 끝으로 스크롤한다(D10)
  useEffect(() => {
    const el = cards.current;
    if (el && items.length) el.scrollTop = el.scrollHeight;
  }, [items.length]);
  // 카드가 취소로 닫힐 때 초점이 그 안에 있었으면 입력칸으로 돌린다(D9)
  useEffect(() => {
    if (!cancelN || !cardFocus.current) return;
    const el = document.activeElement;
    if (!el || el === document.body || !cards.current?.contains(el)) {
      cardFocus.current = false;
      refocus();
    }
  }, [cancelN]); // eslint-disable-line react-hooks/exhaustive-deps
  // 줄 안 단추에 있던 포커스가 줄과 함께 사라지면 입력 칸으로(DR13). 막힌 보내기·멈춤 단추에 있던 포커스도 입력 칸으로
  useEffect(() => {
    if (!view && rowFocus.current) {
      rowFocus.current = false;
      refocus();
    }
  }, [view]); // eslint-disable-line react-hooks/exhaustive-deps
  useEffect(() => {
    const el = document.activeElement as HTMLElement | null;
    if (blocked && el?.tagName === 'BUTTON' && el.closest('[data-guide="chat.composer"]')) refocus();
  }, [blocked]); // eslint-disable-line react-hooks/exhaustive-deps

  useEffect(() => {
    if (store.draft && store.draft !== input) setInput(store.draft);
  }, [store.draft]); // eslint-disable-line react-hooks/exhaustive-deps

  // 서랍·뷰어의 「AI 에게 묻기」(스펙 2026-10-20-002 DD10): 칸이 비었을 때만 글을 채우고 입력 칸으로 포커스
  useEffect(() => {
    if (!store.composeSeq) return;
    if (!input.trim()) setInput(store.composeOffer);
    setTimeout(refocus, 0);
  }, [store.composeSeq]); // eslint-disable-line react-hooks/exhaustive-deps

  // 대화 영역 밖에 떨어뜨려도 브라우저가 파일을 열어 화면을 떠나지 않게 창 전체의 기본 놓기를 막는다(D18)
  useEffect(() => {
    if (!files) return;
    const stop = (e: DragEvent) => {
      if (e.dataTransfer?.types?.includes('Files')) e.preventDefault();
    };
    window.addEventListener('dragover', stop);
    window.addEventListener('drop', stop);
    return () => {
      window.removeEventListener('dragover', stop);
      window.removeEventListener('drop', stop);
    };
  }, [files]);

  const onDrop = (e: React.DragEvent) => {
    e.preventDefault();
    setDragging(false);
    if (!files) return;
    const picked: File[] = [];
    const rejected: { name: string; code: string }[] = [];
    const items = Array.from(e.dataTransfer.items ?? []);
    Array.from(e.dataTransfer.files).forEach((f, i) => {
      const entry = items[i]?.webkitGetAsEntry?.();
      if (entry?.isDirectory) rejected.push({ name: f.name, code: 'folder' });   // 폴더는 zip 으로(D7)
      else picked.push(f);
    });
    store.addFiles(picked, rejected);
  };

  // 입력창 「/」 스킬(스펙 2026-10-19-012 P4). 지금 대화 중인 에이전트·프로파일의 목록을 처음 열 때 읽는다
  const skillUrl = profile ? `/api/chat/skills?${new URLSearchParams({ profile, ...(store.pod ? { pod: store.pod } : {}) })}` : null;
  const skills = useSkillSuggest(skillUrl);
  // 「/」 목록: 명령 → 스킬 두 묶음(스펙 2026-10-26-010 DC1). 답하는 중이면 /steer·/queue 만(DC6)
  const slash = slashItems(skills.data, busy);
  // 글 맨 앞 「/낱말」로 할 일을 정한다: 명령 실행·스킬 붙이기·막기(DC5·DC10)
  const plan = planSlash(input, skills, skillSuggestItems(skills.data), busy);
  const compressing = !!S?.compressing;
  const leadingSlash = /^\s*\//.test(input);
  useEffect(() => {
    if (leadingSlash) skills.open(); // 붙여 넣은 명령도 목록을 읽어 알아본다(DC5)
    // skills.open 은 목록 주소가 바뀌면 새로 생긴다 — 「/」를 친 채 대화가 다시 열려 주소가 바뀌면 목록이 「읽는 중」에 멈췄다(스펙 2026-10-27-002 9-5)
  }, [leadingSlash, skills.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const send = async () => {
    if (plan.block || compressing) return;
    if (plan.command) {
      if (plan.command.name === 'compress') setInput(''); // 최대 180초 기다린다 — 친 글을 그동안 입력창에 두지 않는다(OKE 화면 확인 2026-10-27)
      const r = await store.command(plan.command.name, plan.command.arg);
      if (r === 'clear') setInput('');
      else if (r === 'prefill') setInput(store.draft);
      refocus();
      return;
    }
    const text = input;
    const r = await store.send(text, undefined, plan.skill);
    if (r === 'sent' || r === 'failed') {
      setInput('');
      refocus(); // 보낸 뒤에도 다음에 쓸 곳은 입력칸이다(디자인 리뷰 3-1)
    }
  };
  const close = () => setAnchor(null);
  const link = (to: string, label: string) => (
    <MenuItem component={Link} to={to} onClick={close}>
      {label}
    </MenuItem>
  );
  const canSend = (!!input.trim() || store.uploads.some((u) => u.state === 'done' && u.path)) && !plan.block && !compressing && (!busy || !!plan.command);
  // 말로 입력(스펙 2026-10-22-005 §3-10): 채팅은 대화 상대의 에이전트·프로파일로 받아쓴다. AAS 연결이 다시 여는 중이거나(blocked) 상태에 error 가 있으면 막는다(§11 M3).
  // connected 는 보지 않는다 — AAS↔Hermes 채팅 웹소켓이 지금 열려 있는지일 뿐이고(대화를 보낼 때만 열림), 받아쓰기는 HTTP 다.
  // conversation: 같은 프로파일에서 새 대화·지난 대화로 바꿔도 녹음을 버린다(21A). Conversation 은 프로파일로만 key 를 잡아 다시 그려지지 않는다
  const vst = store.group() ?? store.status;
  const voice = profile
    ? {
        pod: store.status?.pod,
        profile,
        conversation: conversationKey(S),
        stt: vst?.stt,
        sttStream: vst?.stt_stream,
        sttStreamMaxSeconds: vst?.stt_stream_max_seconds,
        blockedReason: blocked || vst?.error ? t('voice.blocked') : undefined,
        refresh: () => void store.refresh(),
      }
    : undefined;
  const barBtn = (label: string, short: string, icon: React.ReactNode, onClick: () => void) => (
    <Tooltip title={label}>
      <Button
        size="small"
        variant="outlined"
        color="inherit"
        aria-label={label}
        startIcon={iconOnly ? undefined : icon}
        onClick={onClick}
        sx={[
          tier2 as object,
          iconOnly ? { minWidth: 0, px: 0.75 } : {},
          { '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } },
        ]}
      >
        {iconOnly ? icon : short}
      </Button>
    </Tooltip>
  );

  return (
    <Box
      component="section"
      aria-label={t('chat.conversationWith', { title })}
      sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, height: '100%', position: 'relative' }}
      onDragOver={(e) => {
        if (files && e.dataTransfer.types.includes('Files')) {
          e.preventDefault();
          setDragging(true);
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node)) setDragging(false);
      }}
      onDrop={onDrop}
    >
      {dragging && (
        <Box
          aria-hidden
          sx={{
            position: 'absolute',
            inset: 0,
            zIndex: 2,
            border: `1px dashed ${tk.composerFocus}`,
            borderRadius: `${chatMetrics.panelRadius}px`,
            bgcolor: tk.canvas,
            opacity: 0.92,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            gap: 1,
            color: tk.text,
            pointerEvents: 'none',
          }}
        >
          <AttachFileIcon />
          <Typography>{t('chat.files.dropHere')}</Typography>
        </Box>
      )}
      <Stack
        direction="row"
        spacing={1.5}
        alignItems="center"
        sx={{ minHeight: 56, px: 1.5, py: 1, borderBottom: `1px solid ${tk.line}`, bgcolor: tk.rail }}
      >
        {onBack && (
          <IconButton
            aria-label={t('chat.backToList')}
            onClick={onBack}
            sx={{ display: { md: 'none' }, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } }}
          >
            <ArrowBackIcon />
          </IconButton>
        )}
        <AgentAvatar name={colorKeyOf(g, a)} label={rowTitle(g, a)} size={32} dot={a.running === false ? 'off' : a.running ? 'on' : undefined} />
        {/* 세션 중심: 머리 첫 줄은 세션 제목, 둘째 줄은 이 세션이 도는 에이전트 — 어느 에이전트의 세션인지 늘 보이게 */}
        <Box sx={{ flex: 1, minWidth: 0 }} data-testid="chat-head">
          <Box sx={{ display: 'flex', alignItems: 'center', gap: 0.75, minWidth: 0 }}>
            {S && <StateMark state={store.stateOf(S)} />}
            <Box component="strong" title={S?.title || t('chat.sessUntitled')} sx={{ display: 'block', fontSize: 14, fontWeight: 700, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
              {S?.title || t('chat.sessUntitled')}
            </Box>
          </Box>
          {/* 부제 줄 높이를 늘 잡아 둔다 — 비어 있다가 답하는 동안만 생기면 제목이 흔들렸다(DD7) */}
          <Typography
            variant="caption"
            component="div"
            noWrap
            title={(one ? t('chat.profileTip', { title, name: a.name }) : title) + (agentSub(a, one) ? ` · ${agentSub(a, one)}` : '')}
            sx={{ color: tk.muted, fontSize: 12, minHeight: 16 }}
          >
            {t('chat.sessRunsOn', { agent: title })}
            {busy ? ` · ${t('chat.replying')}` : ''}
          </Typography>
        </Box>
        {/* 메뉴 안에 있던 동작을 머리줄 단추로 꺼냈다(스펙 §5 D5). 링크 다섯 개만 ⋯ 메뉴에 남는다 */}
        {/* 가이드(OMAI-1274 user.past-chat·user.file-viewer)가 강조하는 자리 */}
        <Box component="span" data-guide="chat.new" sx={{ display: 'inline-flex' }}>
          {barBtn(t('chat.newSessionSame'), t('chat.newSession'), <AddCommentOutlinedIcon sx={{ fontSize: 18 }} />, () => {
            store.newChat();
            refocus();
          })}
        </Box>
        <Box component="span" data-guide="chat.past" sx={{ display: 'inline-flex' }}>
          {barBtn(t('chat.viewPast'), t('chat.viewPastShort'), <HistoryOutlinedIcon sx={{ fontSize: 18 }} />, () => panel('past'))}
        </Box>
        {files && (
          <Box component="span" data-guide="chat.files" sx={{ display: 'inline-flex' }}>
            {barBtn(t('chat.files.menu'), t('chat.files.menu'), <FolderOpenOutlinedIcon sx={{ fontSize: 18 }} />, () => panel('files'))}
          </Box>
        )}
        <Tooltip title={t('chat.menu')}>
          <IconButton
            aria-label={t('chat.menu')}
            aria-haspopup="menu"
            aria-expanded={!!anchor}
            size="small"
            onClick={(e) => setAnchor(e.currentTarget)}
            sx={{ color: tk.muted, '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } }}
          >
            <MoreHorizIcon />
          </IconButton>
        </Tooltip>
        <Menu anchorEl={anchor} open={!!anchor} onClose={close}>
          <Typography variant="caption" color="text.secondary" sx={{ px: 2 }}>
            {t('chat.ofThisAgent')}
          </Typography>
          {link(`/profiles?name=${encodeURIComponent(profile)}`, t('chat.linkProfile'))}
          {link(`/cron?${new URLSearchParams({ tab: 'profiles', q: profile })}`, t('chat.linkCron'))}
          {link(`/skills?${new URLSearchParams({ tab: 'all', profile })}`, t('chat.linkSkills'))}
          {link(`/channels?${new URLSearchParams({ tab: 'all', q: profile })}`, t('chat.linkChannels'))}
          {link(`/credentials?${new URLSearchParams({ tab: 'all', profile })}`, t('chat.linkCredentials'))}
        </Menu>
      </Stack>
      {store.notice && <Alert severity="error">{store.notice}</Alert>}
      {compact || (S && (S.items.length || S.storedId || S.busy)) ? (
        <Messages S={S} store={store} profile={profile} onPanel={panel} />
      ) : (
        // 아직 보내지 않은 새 세션: 가운데 큰 안내 + 아래 큰 입력 카드(Claude·Gemini 첫 화면처럼)
        <Box data-testid="new-session-hero" sx={{ flex: 1, minHeight: 0, display: 'flex', flexDirection: 'column', alignItems: 'center', justifyContent: 'flex-end', px: 2, pb: 2, textAlign: 'center' }}>
          <AgentAvatar name={colorKeyOf(g, a)} label={rowTitle(g, a)} size={48} tone="hue" />
          <Typography component="h2" sx={{ mt: 1.5, fontSize: 22, fontWeight: 700, color: tk.text }}>
            {t('chat.newSessionHeading')}
          </Typography>
          <Typography sx={{ mt: 0.5, fontSize: 13, color: tk.muted, maxWidth: 520 }}>{t('chat.newSessionSub', { agent: title })}</Typography>
        </Box>
      )}
      <Stack
        ref={cards}
        spacing={1}
        onFocusCapture={() => {
          cardFocus.current = true;
        }}
        onBlurCapture={(e) => {
          // 다른 곳으로 옮긴 초점만 끈다. 카드가 사라지며 초점을 잃은 경우(relatedTarget 없음)는 남겨 입력칸으로 돌린다
          const next = e.relatedTarget as Node | null;
          if (next && !cards.current?.contains(next)) cardFocus.current = false;
        }}
        sx={{ px: 2, pb: 1, maxWidth: chatColumnPad, mx: 'auto', width: '100%', maxHeight: '50vh', '@supports (height: 1dvh)': { maxHeight: '50dvh' }, overflowY: 'auto' }}
      >
        {/* 카드가 취소로 닫히면 그 줄의 문구를 한 번 읽는다. 카드가 없어도 늘 그려 두어야 마지막 카드가 닫힐 때도 읽는다(D9·F13) */}
        <Box role="status" sx={hiddenSx}>
          {lastCancelled ? cancelLine(lastCancelled) + (cancelN % 2 ? ' ' : '') : ''}
        </Box>
        {items.map((it) =>
          it.kind === 'approval' ? (
            <ApprovalCard key={String((it.p as Record<string, unknown>)?.request_id)} it={it} store={store} onDone={refocus} />
          ) : (
            <ClarifyCard key={`${it.request_id}:${it.qid}`} it={it} store={store} onDone={refocus} />
          )
        )}
      </Stack>
      <Box sx={{ px: 2, pb: 1.5, pt: 0.5 }}>
        <Box sx={{ maxWidth: chatColumn, mx: 'auto' }} data-guide="chat.composer">
          {/* 화면 읽기 프로그램 알림: 연결 대기·다시 여는 중·다시 열림·포기 네 순간만(DR12). 지금 보는 대화의 것만 */}
          <Box role="status" sx={hiddenSx}>
            {S && store.announceFor === S.id ? store.announce + (store.announceSeq % 2 ? ' ' : '') : ''}
          </Box>
          {teamOwner && <TeamStatusRow text={t('chat.sendingToTeam', { owner: teamOwner })} />}
          {view && (
            <Box
              onFocusCapture={() => {
                rowFocus.current = true;
              }}
              onBlurCapture={() => {
                rowFocus.current = false;
              }}
            >
              {view.mode === 'wait' ? (
                <ReconnectRow text={t('chat.reconnect.wait')} short={t('chat.reconnect.waitShort')} compact={compact} />
              ) : (
                <ReconnectRow
                  text={t('chat.reconnect.reopening')}
                  short={t('chat.reconnect.reopeningShort')}
                  nextAt={view.nextAt}
                  compact={compact}
                  action={S ? { label: t('chat.reconnect.now'), onClick: () => store.reopenNow(S) } : undefined}
                />
              )}
            </Box>
          )}
          {S?.claude?.active && (
            <Alert
              severity="info"
              data-testid="claude-using"
              sx={{ mx: compact ? 1 : 2, mb: 1, py: 0 }}
              action={
                <Button color="inherit" size="small" onClick={() => void store.refreshClaude(S)}>
                  {t('chat.claudeRefresh')}
                </Button>
              }
            >
              {t('chat.claudeUsing')}
            </Alert>
          )}
          {S && (
            <CommandRows
              compressing={S.compressing}
              compressSlow={S.compressSlow}
              queue={S.queue}
              queueHeld={S.queueHeld}
              queueLost={S.queueLost}
              flash={S.flash}
              retryFailed={S.retryFailed}
              compact={compact}
              hideGray={!!view}
              onQueue={(op, id) => void store.queueOp(op, id)}
              onCheck={() => {
                store.dismissCommandRow('compressSlow');
                void store.command('status', '');
              }}
              onDismiss={(w) => store.dismissCommandRow(w)}
              control={S.control}
              btwWait={S.btwWait}
              canControl={!!skills.data?.commands?.some((c) => c.name === 'goal')}
              onControl={(command, op) => void store.command(command, op)}
            />
          )}
          <Composer
            ref={composer}
            variant={compact ? 'default' : 'prominent'}
            target={
              compact ? undefined : (
                <Box
                  component="span"
                  data-testid="composer-target"
                  title={t('chat.sessTarget', { agent: title })}
                  sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5, px: 1, py: 0.25, borderRadius: 999, border: `1px solid ${tk.line}`, fontSize: 12, color: tk.muted, maxWidth: 220, minWidth: 0 }}
                >
                  <AgentAvatar name={colorKeyOf(g, a)} label={rowTitle(g, a)} size={16} tone="hue" />
                  <Box component="span" sx={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                    {title}
                  </Box>
                </Box>
              )
            }
            value={input}
            onChange={setInput}
            onSend={send}
            sendOn="enter"
            canSend={canSend && !blocked}
            busy={busy || compressing}
            sendWhileBusy={busy && !!plan.command}
            onStop={() => store.interrupt()}
            stopDisabled={blocked || compressing}
            placeholder={t('chat.inputPlaceholderSkills', { title })}
            inputLabel={t('chat.inputLabel', { title })}
            sendLabel={t('chat.send')}
            stopLabel={t('chat.interrupt')}
            compact={compact}
            hint={
              busy
                ? t('chat.cmd.busyHint')
                : uploading
                  ? t('chat.files.uploadingHint')
                  : files
                    ? `${t('chat.keyHint')} · ${t('chat.files.limitHint')}`
                    : t('chat.keyHint')
            }
            note={blocked ? t('chat.reconnect.note') : plan.note ? <SlashNote text={plan.note} warn={plan.warn} /> : undefined}
            suggest={[slashSource(skills, slash)]}
            voice={voice}
            readConv={conversationKey(S)}
            top={files && store.uploads.length ? <UploadRow store={store} /> : undefined}
            leading={
              files ? (
                <>
                  <input
                    ref={picker}
                    type="file"
                    multiple
                    hidden
                    onChange={(e) => {
                      store.addFiles(Array.from(e.target.files ?? []));
                      e.target.value = '';
                    }}
                  />
                  <Tooltip title={t('chat.files.attach')}>
                    <IconButton aria-label={t('chat.files.attach')} data-guide="chat.attach" size="small" onClick={() => picker.current?.click()} sx={{ color: tk.muted }}>
                      <AttachFileIcon fontSize="small" />
                    </IconButton>
                  </Tooltip>
                </>
              ) : undefined
            }
          />
          {files && store.uploads.length > 0 && (
            <Box aria-live="polite" sx={hiddenSx}>
              {t('chat.files.liveSummary', {
                done: store.uploads.filter((u) => u.state === 'done').length,
                fail: store.uploads.filter((u) => u.state === 'fail').length,
              })}
            </Box>
          )}
        </Box>
      </Box>
    </Box>
  );
}

export function Chat({ store = chatStore }: { store?: ChatStore }) {
  useChat(store);
  const pickSession = usePickSession(store);
  const pickAgent = usePickAgent(store);
  const [, setParams] = useSearchParams();
  const agentSearch = useRef<HTMLInputElement>(null);
  const pickSearch = useRef<HTMLInputElement>(null);
  const [layout, update] = useChatLayout();
  const [picking, setPicking] = useState(false);
  // 테스트 환경의 matchMedia 는 늘 거짓이라 「좁을 때」 조건으로 쓴다 — 시험은 넓은 3칸으로 돈다
  const narrow = useMediaQuery('(max-width:899.98px)');
  const medium = useMediaQuery('(max-width:1279.98px)');
  const agentsStrip = medium || layout.agentsCollapsed;
  // ⌘/Ctrl+B: 세션 칸 접기·펴기(편집 칸 안의 굵게와 겹치지 않게 입력 중에는 하지 않는다)
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.metaKey || e.ctrlKey) || e.altKey || e.shiftKey || e.key.toLowerCase() !== 'b') return;
      const el = e.target as HTMLElement | null;
      if (el && (el.isContentEditable || /^(INPUT|TEXTAREA|SELECT)$/.test(el.tagName))) return;
      e.preventDefault();
      update({ sessionsCollapsed: !layoutRef.current.sessionsCollapsed });
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [update]);
  const layoutRef = useRef(layout);
  layoutRef.current = layout;
  const { context, title } = chatTitle(useMe().data); // 오피스처럼 회사는 맥락, 「<부서> 채팅」은 제목. 좌측 메뉴는 「채팅」 그대로
  const { back } = useChatAddress(store);
  const openPanel = useChatPanel(store);
  const tk = useChatTokens();

  useEffect(() => {
    store.preload();
  }, [store]);

  const st = store.status;
  // 다른 화면처럼 제목 아래 빨간 진행 막대로 읽는 중을 보인다
  if (!st) return <ScreenLoading title={title} context={context} />;
  if (!st.configured)
    return (
      <Box>
        <PageTitle gutterBottom context={context}>
        {title}
      </PageTitle>
        <Box sx={{ maxWidth: 720, mx: 'auto', mt: 4 }}>
          <Alert severity="warning">{t('chat.notConfigured')}</Alert>
          <Paper variant="outlined" sx={{ p: 2, mt: 2 }}>
            <Typography variant="h6" component="h3">
              {t('chat.setupHeading')}
            </Typography>
            <p>{t('chat.setupText')}</p>
            <Box component="pre" sx={{ fontFamily: MONO_FONT }}>{`${
              st.env_file || '/etc/aas/aas.env'
            }\n\nAAS_DASHBOARD_USER=…\nAAS_DASHBOARD_PASSWORD=…`}</Box>
            <Typography variant="caption" color="text.secondary">
              {st.error || ''}
            </Typography>
          </Paper>
        </Box>
      </Box>
    );

  const hasAgent = !!store.profile;
  // 3칸(AI 에이전트 | 세션 | 대화). 900–1279px 은 AI 에이전트 칸을 아바타 띠로, 900px 아래는 한 칸씩(세션 목록 → 대화)
  const agentsW = agentsStrip ? STRIP_W : layout.agentsW;
  const sessionsW = layout.sessionsCollapsed ? SESSION_STRIP_W : layout.sessionsW;
  const columns = narrow ? '1fr' : `${agentsW}px 0px ${sessionsW}px 0px minmax(0, 1fr)`;
  const agentsPanel = agentsStrip ? (
    <AgentStrip
      store={store}
      onPick={pickAgent}
      onExpand={() => update({ agentsCollapsed: false })}
      onSearch={() => setPicking(true)}
      canExpand={!medium}
    />
  ) : (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, bgcolor: tk.rail }}>
      <Box sx={{ display: 'flex', alignItems: 'center', px: 1.5, pt: 1.25, minHeight: 36 }}>
        <Typography component="h3" sx={{ flex: 1, fontSize: chatType.meta, fontWeight: 600, color: tk.muted }}>
          {t('chat.tabAgents')}
        </Typography>
        <Tooltip title={t('chat.agentsCollapse')}>
          <IconButton size="small" aria-label={t('chat.agentsCollapse')} onClick={() => update({ agentsCollapsed: true })} sx={{ color: tk.muted }}>
            <ChevronLeftIcon fontSize="small" />
          </IconButton>
        </Tooltip>
      </Box>
      <AgentList store={store} searchRef={agentSearch} />
    </Box>
  );
  const sessionsPanel = layout.sessionsCollapsed && !narrow ? (
    <SessionStrip store={store} onExpand={() => update({ sessionsCollapsed: false })} />
  ) : (
    <Box sx={{ display: 'flex', flexDirection: 'column', minHeight: 0, flex: 1, bgcolor: tk.rail }}>
      <SessionList
        store={store}
        onPick={(r) => void pickSession(r)}
        onNew={() => {
          if (!narrow && !agentsStrip && agentSearch.current) agentSearch.current.focus();
          else setPicking(true);
        }}
        onCollapse={narrow ? undefined : () => update({ sessionsCollapsed: true })}
        onCurrentClosed={() =>
          setParams(
            (prev) => {
              const next = new URLSearchParams(prev);
              next.delete('session');
              return next;
            },
            { replace: true }
          )
        }
      />
    </Box>
  );
  const conversation = hasAgent ? (
    <Conversation key={`${store.status?.pod ?? ''}|${store.profile}`} store={store} onBack={back} onPanel={openPanel} />
  ) : (
    <Box sx={{ mt: 8, px: 3, textAlign: 'center' }}>
      <Typography sx={{ color: tk.muted }}>{narrow ? t('chat.pickSession') : t('chat.pickAgentHint')}</Typography>
    </Box>
  );
  return (
    <Box>
      {/* 오피스처럼 본문 위에 제목을 둔다. 제목 높이만큼 대화 영역을 줄인다 */}
      <PageTitle gutterBottom context={context}>
        {title}
      </PageTitle>
      <ChatFrame offset="168px" sx={{ display: 'grid', gridTemplateColumns: columns, gridTemplateRows: 'minmax(0, 1fr)' }}>
        {/* 지난 대화를 여는 동안 다른 화면과 같은 빨간 막대. 겹쳐 그려 아래 내용을 밀지 않는다 */}
        {store.opening && (
          <LinearProgress
            aria-label={t('chat.loadingPast')}
            sx={{ position: 'absolute', top: 0, left: 0, right: 0, zIndex: 3 }}
          />
        )}
        {narrow ? (
          <Box sx={{ minHeight: 0, overflow: 'auto' }}>
            {!hasAgent && store.notice && <Alert severity="error">{store.notice}</Alert>}
            {hasAgent ? conversation : sessionsPanel}
          </Box>
        ) : (
          <>
            <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${tk.line}` }}>{agentsPanel}</Box>
            {agentsStrip ? <Box /> : (
              <Splitter
                label={t('chat.resizeAgents')}
                value={layout.agentsW}
                limits={LIMITS.agents}
                onChange={(v) => update({ agentsW: v })}
                onToggle={() => update({ agentsCollapsed: true })}
              />
            )}
            <Box sx={{ minHeight: 0, display: 'flex', flexDirection: 'column', overflow: 'hidden', borderRight: `1px solid ${tk.line}` }}>
              {!hasAgent && store.notice && <Alert severity="error">{store.notice}</Alert>}
              {sessionsPanel}
            </Box>
            {layout.sessionsCollapsed ? <Box /> : (
              <Splitter
                label={t('chat.resizeSessions')}
                value={layout.sessionsW}
                limits={LIMITS.sessions}
                onChange={(v) => update({ sessionsW: v })}
                onToggle={() => update({ sessionsCollapsed: true })}
              />
            )}
            <Box sx={{ minHeight: 0, minWidth: 0, display: 'flex', flexDirection: 'column' }}>{conversation}</Box>
          </>
        )}
      </ChatFrame>
      <Dialog
        open={picking}
        onClose={() => setPicking(false)}
        fullScreen={narrow}
        fullWidth
        maxWidth="xs"
        aria-labelledby="chat-pick-agent-title"
        TransitionProps={{ onEntered: () => pickSearch.current?.focus() }}
        slotProps={{ paper: { sx: { height: narrow ? '100%' : '70vh' } } }}
      >
        <DialogTitle id="chat-pick-agent-title" sx={{ pb: 0.5, fontSize: 16 }}>
          {t('chat.pickAgentTitle')}
        </DialogTitle>
        <DialogContent sx={{ p: 0, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
          {picking && <AgentList store={store} onPicked={() => setPicking(false)} searchRef={pickSearch} />}
        </DialogContent>
      </Dialog>
    </Box>
  );
}

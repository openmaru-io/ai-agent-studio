/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 화면의 작은 조각: 아바타, 진행 단계, 승인·되묻기 카드, 지난 대화 서랍.
import ChatBubbleOutlineIcon from '@mui/icons-material/ChatBubbleOutline';
import ExpandMoreIcon from '@mui/icons-material/ExpandMore';
import GppBadOutlinedIcon from '@mui/icons-material/GppBadOutlined';
import {
  Alert,
  Box,
  Button,
  Checkbox,
  CircularProgress,
  FormControlLabel,
  NativeSelect,
  Stack,
  TextField,
  Typography,
  useTheme,
} from '@mui/material';
import { useEffect, useState } from 'react';

import { Tag } from '@/components/bits';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { ItemEmpty, ItemList, ItemRow } from '@/components/ItemRow';
import { SubtleBadge } from '@/components/SubtleBadge';
import { tier1, tier2 } from '@/components/tierButton';
import { useUi } from '@/components/UiContext';
import { t } from '@/i18n';
import type { Item } from '@/lib/chat';
import { ChatStore, StoredSession } from '@/lib/chatStore';
import { avatarTile, chatMetrics, chatType, hueOf } from '@/lib/chatTokens';
import { markCronSeen, seenCron } from '@/lib/cronSeen';
import { SRC } from '@/lib/labels';
import { MONO_FONT } from '@/lib/monoFont';
import { FOCUS_RING } from '@/lib/shellTokens';

/**
 * 에이전트 아바타: 둥근 사각형 타일(스펙 D2). 채팅·AgentChat 은 단색(tone="mono"), 회의만 색조(tone="hue")로 에이전트를 구분한다(디자인 리뷰 4-1).
 * dot 이 있으면 오른쪽 아래에 게이트웨이 상태 점(동작 중 초록, 멈춤은 속 빈 테두리)을 붙인다.
 */
export function AgentAvatar({
  name,
  label,
  size = 40,
  tone = 'mono',
  dot,
}: {
  name: string;
  label?: string;
  size?: number;
  tone?: 'mono' | 'hue';
  dot?: 'on' | 'off';
}) {
  const tk = useChatTokens();
  const mode = useTheme().palette.mode;
  const text = (label || name || '?').trim();
  const hue = tone === 'hue' ? avatarTile(hueOf(name), mode) : null;
  return (
    <Box
      aria-hidden="true"
      sx={{
        position: 'relative',
        flexShrink: 0,
        width: size,
        height: size,
        borderRadius: `${size >= 48 ? chatMetrics.bigTileRadius : chatMetrics.tileRadius}px`,
        bgcolor: hue ? hue.bg : tk.monoTile,
        color: hue ? hue.fg : tk.text,
        display: 'flex',
        alignItems: 'center',
        justifyContent: 'center',
        fontSize: size * 0.4,
        fontWeight: 500,
        userSelect: 'none',
      }}
    >
      {text.slice(0, /[가-힣]/.test(text[0]) ? 1 : 2).toUpperCase()}
      {dot && (
        <Box
          component="span"
          sx={{
            position: 'absolute',
            right: -2,
            bottom: -2,
            width: 8,
            height: 8,
            borderRadius: '50%',
            boxSizing: 'border-box',
            border: dot === 'on' ? 0 : `1.5px solid ${tk.muted}`,
            bgcolor: dot === 'on' ? '#27a644' : 'transparent',
            boxShadow: `0 0 0 2px ${mode === 'dark' ? '#0f1011' : '#edeef2'}`,
          }}
        />
      )}
    </Box>
  );
}

const CHOICE_KEY: Record<string, string> = {
  once: 'chat.choiceOnce',
  session: 'chat.choiceSession',
  always: 'chat.choiceAlways',
  deny: 'chat.choiceDeny',
};
/** 승인 선택지의 이름. 모르는 값은 그대로 보인다. */
export const choiceLabel = (c: string): string => (CHOICE_KEY[c] ? t(CHOICE_KEY[c]) : c);

/** 취소로 닫힌 승인·되묻기 카드가 남기는 줄(스펙 2026-10-23-005 디자인 D4). shutdown 은 대화 닫힘과 같은 문구다 */
export function cancelLine(it: Item): string {
  const why = it.cancelled === 'shutdown' ? 'session_closed' : it.cancelled;
  const reason = ['timeout', 'interrupted', 'session_closed', 'resolved'].includes(String(why)) ? String(why) : 'timeout';
  return it.kind === 'approval' ? t(`chat.cancel.approval.${reason}`) : t(`chat.cancel.clarify.${reason}`, { question: it.question || '' });
}

// ---- 진행 단계 ----
const hiddenSx = {
  position: 'absolute',
  width: 1,
  height: 1,
  overflow: 'hidden',
  clip: 'rect(0 0 0 0)',
  whiteSpace: 'nowrap',
} as const;

function StepDot({ state }: { state: 'run' | 'bad' | 'ok' }) {
  return (
    <Box
      component="span"
      aria-hidden="true"
      sx={{
        display: 'inline-block',
        width: 8,
        height: 8,
        borderRadius: '50%',
        flexShrink: 0,
        bgcolor: state === 'run' ? '#f59e0b' : state === 'bad' ? '#ef5350' : '#27a644',
        ...(state === 'run'
          ? {
              animation: 'stepPulse 1.2s ease-in-out infinite',
              '@keyframes stepPulse': { '0%, 100%': { opacity: 0.45 }, '50%': { opacity: 1 } },
              '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
            }
          : {}),
      }}
    />
  );
}

/**
 * 진행 단계 머리줄의 점. 진행 중이면 크기가 다른 호박색 점 둘이 작은 원을 돈다(OMAI-1447, 「Claude 처럼」).
 * 끝나면 멈춘 점 하나. 상자를 12px 로 고정해 상태가 바뀌어도 글이 밀리지 않는다. 움직임 줄이기 설정에서는 멈춘 점 하나다.
 */
function HeadDot({ state }: { state: 'run' | 'bad' | 'ok' }) {
  const box = { display: 'inline-flex', alignItems: 'center', justifyContent: 'center', width: 12, height: 12, flexShrink: 0 } as const;
  if (state !== 'run')
    return (
      <Box component="span" aria-hidden="true" data-dot={state} sx={box}>
        <StepDot state={state} />
      </Box>
    );
  const orb = (size: number, side: 'left' | 'right', delay: string) => ({
    position: 'absolute',
    top: '50%',
    [side]: 0,
    width: size,
    height: size,
    mt: `${-size / 2}px`,
    borderRadius: '50%',
    bgcolor: '#f59e0b',
    animation: `orbitPulse 1.2s ease-in-out ${delay} infinite`,
    '@media (prefers-reduced-motion: reduce)': side === 'left' ? { animation: 'none', left: 2, width: 8, height: 8, mt: '-4px' } : { display: 'none' },
  });
  return (
    <Box
      component="span"
      aria-hidden="true"
      data-dot="run"
      sx={{
        ...box,
        position: 'relative',
        animation: 'orbitSpin 1.2s linear infinite',
        '@keyframes orbitSpin': { to: { transform: 'rotate(360deg)' } },
        '@keyframes orbitPulse': { '0%, 100%': { transform: 'scale(1)' }, '50%': { transform: 'scale(0.55)' } },
        '@media (prefers-reduced-motion: reduce)': { animation: 'none' },
      }}
    >
      <Box component="span" sx={orb(6, 'left', '0s')} />
      <Box component="span" sx={orb(4, 'right', '-0.6s')} />
    </Box>
  );
}

// 안전장치 차단 표시(스펙 2026-10-24-004). 단계 실패 점과 같은 빨강 — DESIGN.md 1-1.1 Alert/Critical 용도
const GUARD_RED = '#ef5350';

/** 에이전트 답 위의 빨간 표시: 안전장치(hardline·운영자 거절 규칙)가 이 답 앞 단계에서 명령을 막았다. 아이콘과 글을 함께 쓴다 */
export function GuardMark({ reason }: { reason: string }) {
  const label = t('chat.guardMark');
  return (
    <Box
      role="note"
      aria-label={label}
      sx={{
        display: 'flex',
        alignItems: 'flex-start',
        gap: 0.75,
        mb: 1,
        px: 1,
        py: 0.5,
        borderLeft: `3px solid ${GUARD_RED}`,
        borderRadius: '4px',
        bgcolor: 'rgba(239, 83, 80, 0.10)',
        fontSize: chatType.tool + 1,
        lineHeight: 1.5,
      }}
    >
      <GppBadOutlinedIcon aria-hidden="true" sx={{ fontSize: 18, color: GUARD_RED, mt: '1px', flexShrink: 0 }} />
      <Box sx={{ minWidth: 0 }}>
        <Box component="span" sx={{ color: GUARD_RED, fontWeight: 600 }}>{label}</Box>
        {reason ? (
          <Box component="code" sx={{ display: 'block', fontFamily: MONO_FONT, fontSize: chatType.tool, opacity: 0.85, overflowWrap: 'anywhere' }}>
            {reason}
          </Box>
        ) : null}
      </Box>
    </Box>
  );
}

export function Steps({
  items,
  live,
  open,
  onToggle,
}: {
  items: Item[];
  live: boolean;
  open: boolean;
  onToggle: () => void;
}) {
  const tk = useChatTokens();
  const tools = items.filter((x) => x.kind === 'tool');
  const failed = tools.some((x) => x.state === 'failed');
  const guarded = tools.some((x) => x.guard); // 안전장치 차단(스펙 2026-10-24-004)
  const secs =
    Math.round(((items[items.length - 1].t || 0) - (items[0].t || 0)) / 1000) +
    Math.round(((tools[tools.length - 1]?.ms ?? 0) as number) / 1000);
  const lastIt = [...items].reverse().find((x) => x.kind !== 'reason') ?? items[items.length - 1];
  // 진행 중: 도는 도구 → 그 이름, 기다림 안내 → 그 글, 도구가 끝나 다음 답을 기다리면 「생각하는 중…」
  const head = live
    ? lastIt.kind === 'tool' && lastIt.state === 'running'
      ? `${lastIt.name} ${lastIt.context || ''}`
      : (lastIt.kind === 'status' && lastIt.text) || t('chat.thinking')
    : [
        tools.length ? t('chat.stepsCount', { count: tools.length }) : t('chat.progress'),
        secs > 0 ? t('chat.secs', { n: secs }) : '',
        guarded ? t('chat.guardStep') : failed ? t('chat.hasFailed') : '',
      ]
        .filter(Boolean)
        .join(' · ');
  const rowState = (it: Item): 'run' | 'bad' | 'ok' => (it.state === 'running' ? 'run' : it.state === 'failed' ? 'bad' : 'ok');
  return (
    <Box component="details" open={open} sx={{ my: 1, color: tk.muted, fontSize: chatType.tool + 1 }}>
      <Box
        component="summary"
        onClick={(e: React.MouseEvent) => {
          e.preventDefault();
          onToggle();
        }}
        sx={{
          display: 'flex',
          alignItems: 'center',
          gap: 1,
          cursor: 'pointer',
          listStyle: 'none',
          '&::-webkit-details-marker': { display: 'none' },
          '&:hover': { color: tk.text },
          '&:focus-visible': { outline: `2px solid ${FOCUS_RING}`, outlineOffset: 2, borderRadius: '4px' },
        }}
      >
        <HeadDot state={live ? 'run' : failed ? 'bad' : 'ok'} />
        <span>{String(head).slice(0, 120)}</span>
        <ExpandMoreIcon
          aria-hidden="true"
          sx={{ fontSize: 16, transition: 'transform 120ms', transform: open ? 'rotate(180deg)' : 'none', '@media (prefers-reduced-motion: reduce)': { transition: 'none' } }}
        />
      </Box>
      <Box component="ul" sx={{ m: 0, mt: 0.75, ml: '3px', pl: 1.5, listStyle: 'none', borderLeft: `1px solid ${tk.line}` }}>
        {items.map((it, i) =>
          it.kind === 'reason' ? (
            it.text?.trim() ? (
              <li key={i}>
                <pre style={{ whiteSpace: 'pre-wrap', margin: 0, font: 'inherit' }}>{it.text}</pre>
              </li>
            ) : null
          ) : (
            <Box component="li" key={i} sx={{ position: 'relative', display: 'flex', alignItems: 'baseline', gap: 1, py: 0.25, lineHeight: 1.5 }}>
              {/* 점은 줄 높이 가운데에 둔다. 고정 top 은 등폭 글꼴과 본문 글꼴의 기준선 맞춤으로 줄이 높아지면 아래로 처졌다 */}
              <Box sx={{ position: 'absolute', left: -16, top: 0, bottom: 0, display: 'flex', alignItems: 'center' }}>
                <StepDot state={it.kind === 'tool' ? rowState(it) : 'ok'} />
              </Box>
              {it.kind === 'tool' ? (
                <>
                  <Box component="code" sx={{ fontFamily: MONO_FONT, fontSize: chatType.tool, color: tk.text }}>
                    {it.name}
                  </Box>
                  {it.context ? <span style={{ minWidth: 0, overflowWrap: 'anywhere' }}>{it.context}</span> : null}
                  {it.ms ? (
                    <Box component="span" sx={{ ml: 'auto', fontVariantNumeric: 'tabular-nums', whiteSpace: 'nowrap' }}>
                      {t('chat.secs', { n: (it.ms / 1000).toFixed(1) })}
                    </Box>
                  ) : null}
                  {it.guard ? (
                    <Box component="span" sx={{ color: GUARD_RED }}>{t('chat.guardRow')}</Box>
                  ) : it.state === 'failed' ? (
                    <span>{t('chat.failed')}</span>
                  ) : null}
                </>
              ) : (
                it.text
              )}
            </Box>
          )
        )}
      </Box>
    </Box>
  );
}

// ---- 승인·되묻기: 입력창 바로 위에 둔다 ----
/** 답 보내기 상태(스펙 2026-10-23-005 디자인 D5·D6). 누른 단추에 진행 표시, 그동안 카드의 다른 조작은 막는다.
 *  실패하면 잠금을 풀고 카드 안에 오류 한 줄을 보인다 — 다시 누를 수 있다. 성공하면 답한 이벤트가 카드를 닫는다. */
function useAnswerSend(onDone?: () => void) {
  const [sending, setSending] = useState<string | null>(null);
  const [error, setError] = useState('');
  const run = async (key: string, send: () => Promise<string | null>) => {
    if (sending) return;
    setSending(key);
    setError('');
    const err = await send();
    if (err) {
      setSending(null);
      setError(err);
    } else onDone?.();
  };
  return { sending, error, run };
}

const sendingIcon = <CircularProgress size={12} color="inherit" />;

function AnswerError({ text }: { text: string }) {
  return text ? (
    <Typography role="alert" variant="body2" color="error" sx={{ mt: 1, fontSize: chatType.meta }}>
      {t('chat.answerFailed', { error: text })}
    </Typography>
  ) : null;
}

/** onDone: 답한 뒤 호출한다(카드가 사라질 때 포커스가 body 로 떨어지지 않게 입력칸으로 돌린다, 디자인 리뷰 3-1) */
export function ApprovalCard({ it, store, onDone }: { it: Item; store: ChatStore; onDone?: () => void }) {
  const tk = useChatTokens();
  const p = (it.p ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const choices: string[] = p.choices?.length ? p.choices : ['once', 'session', 'always', 'deny'];
  const send = useAnswerSend(onDone);
  const off = store.blocked(store.current()) || !!send.sending; // 다시 잇는 중에는 답하지 않는다(스펙 2026-10-20-030 DR5)
  return (
    <Box
      role="group"
      aria-label={t('chat.approvalLabel')}
      aria-busy={!!send.sending}
      sx={{ p: 1.5, border: `1px solid ${tk.warnLine}`, bgcolor: tk.warnWash, borderRadius: `${chatMetrics.panelRadius}px` }}
    >
      {/* 카드가 나타날 때 화면 읽기 프로그램에 즉시 알린다(디자인 리뷰 6-2). 카드의 group 이름은 그대로다 */}
      <Box role="alert" sx={hiddenSx}>
        {t('chat.approvalAlert')}
      </Box>
      <Typography variant="subtitle2" component="h4" sx={{ fontWeight: 700 }}>
        {t('chat.approvalNeeded')}
        {/* Claude Code 가 연 대화면 그쪽도 답할 수 있다 — 먼저 답한 쪽만 간다(스펙 2026-10-28-001 §3-7 ④, 디자인 D13) */}
        {store.current()?.claude ? (
          <Box component="span" sx={{ ml: 1, fontWeight: 400 }}>
            <SubtleBadge>{t('chat.claudeCanAnswer')}</SubtleBadge>
          </Box>
        ) : null}
      </Typography>
      <div>{p.description || p.reason || ''}</div>
      <Box
        component="pre"
        sx={{ whiteSpace: 'pre-wrap', fontFamily: MONO_FONT, fontSize: chatType.tool, my: 1, p: 1, bgcolor: tk.sunken, borderRadius: '8px', color: tk.text }}
      >
        {p.command || p.cmd || JSON.stringify(p)}
      </Box>
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap">
        {choices.map((c) => (
          <Button
            key={c}
            variant="outlined"
            // 한 번 허용만 Tier 1, 나머지 허용은 Tier 2, 거부는 빨강 윤곽선 유지(명령 실행을 막는 안전 단추, 스펙 R10)
            color={c === 'deny' ? 'error' : 'inherit'}
            sx={c === 'once' ? (tier1 as object) : c === 'deny' ? { '@media (pointer: coarse)': { minHeight: chatMetrics.touch } } : (tier2 as object)}
            size="small"
            disabled={off}
            startIcon={send.sending === c ? sendingIcon : undefined}
            onClick={() => send.run(c, () => store.approve(c, p.request_id))}
          >
            {choiceLabel(c)}
          </Button>
        ))}
      </Stack>
      <AnswerError text={send.error} />
    </Box>
  );
}

export function ClarifyCard({ it, store, onDone }: { it: Item; store: ChatStore; onDone?: () => void }) {
  const tk = useChatTokens();
  const label = (c: NonNullable<Item['choices']>[number]) => (typeof c === 'string' ? c : c.label ?? c.value ?? '');
  const [text, setText] = useState('');
  const [picked, setPicked] = useState<string[]>([]);
  const send = useAnswerSend(onDone);
  const answer = (a: string | string[], key = Array.isArray(a) ? 'answer' : a) =>
    send.run(key, () => store.clarify(it.request_id as string, it.qid, a));
  const typed = text.trim();
  const off = store.blocked(store.current()) || !!send.sending; // 다시 잇는 중에는 답하지 않는다(DR5)
  return (
    <Box
      role="group"
      aria-label={t('chat.clarifyLabel')}
      aria-busy={!!send.sending}
      sx={{ p: 1.5, border: `1px solid ${tk.line}`, bgcolor: tk.rail, borderRadius: `${chatMetrics.panelRadius}px` }}
    >
      <Box role="alert" sx={hiddenSx}>
        {t('chat.clarifyAlert')}
      </Box>
      <Typography variant="subtitle2" component="h4" sx={{ fontWeight: 700 }}>
        {it.multi ? t('chat.agentAsksMulti') : t('chat.agentAsks')}
      </Typography>
      <Box sx={{ mb: 1 }}>{it.question || ''}</Box>
      {it.multi &&
        (it.choices ?? []).map((c) => (
          <FormControlLabel
            key={label(c)}
            label={label(c)}
            control={
              <Checkbox
                size="small"
                checked={picked.includes(label(c))}
                disabled={off}
                onChange={(e) =>
                  setPicked((cur) => (e.target.checked ? [...cur, label(c)] : cur.filter((x) => x !== label(c))))
                }
              />
            }
          />
        ))}
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
        {!it.multi &&
          (it.choices ?? []).map((c) => (
            <Button
              key={label(c)}
              variant="outlined"
              color="inherit"
              sx={tier2 as object}
              size="small"
              disabled={off}
              startIcon={send.sending === label(c) ? sendingIcon : undefined}
              onClick={() => answer(label(c))}
            >
              {label(c)}
            </Button>
          ))}
        <TextField
          size="small"
          value={text}
          onChange={(e) => setText(e.target.value)}
          disabled={off}
          placeholder={t('chat.ownAnswerPlaceholder')}
          slotProps={{ htmlInput: { 'aria-label': t('chat.ownAnswerLabel') } }}
          onKeyDown={(e) => {
            if (e.key === 'Enter' && !e.nativeEvent.isComposing && typed && !it.multi) answer(typed, 'answer');
          }}
          sx={{ flex: 1, minWidth: 140 }}
        />
        <Button
          variant="outlined"
          color="inherit"
          sx={tier1 as object}
          size="small"
          disabled={off}
          startIcon={send.sending === 'answer' ? sendingIcon : undefined}
          onClick={() => {
            if (it.multi) {
              const all = typed ? [...picked, typed] : picked;
              if (all.length) answer(all);
            } else if (typed) answer(typed, 'answer');
          }}
        >
          {t('chat.answer')}
        </Button>
      </Stack>
      <AnswerError text={send.error} />
    </Box>
  );
}

// ---- 지난 대화(서랍) ----
const fmtDay = (ts?: number | string) => {
  const d = new Date(Number(ts) * 1000);
  return Number.isNaN(d.getTime()) ? '' : `${d.getMonth() + 1}/${d.getDate()}`;
};

/** onPicked 를 주면 대화를 고른 뒤 서랍을 닫는 대신 부른다 — 주소(panel)로 연 서랍은 그 값을 지워 닫는다(스펙 2026-10-28-014 T7) */
export function PastBody({ store, profile, onPicked }: { store: ChatStore; profile: string; onPicked?: () => void }) {
  const { closeDrawer } = useUi();
  const [rows, setRows] = useState<StoredSession[] | null>(null);
  const [error, setError] = useState('');
  const [src, setSrc] = useState('talk');
  const [q, setQ] = useState('');
  const [seen, setSeen] = useState(seenCron);
  useEffect(() => {
    store
      .history(profile)
      .then(setRows)
      .catch((e: Error) => setError(e.message));
  }, [store, profile]);
  if (error) return <Alert severity="error">{error}</Alert>;
  if (!rows) return <Typography color="text.secondary">{t('chat.loading')}</Typography>;
  const newCron = rows.filter((r) => r.source === 'cron' && !seen.has(r.id)).length;
  const needle = q.trim().toLowerCase();
  const hit = rows.filter(
    (r) =>
      // 「스킬 시험」은 Claude Code 가 purpose skill-test 로 연 대화 — 일하는 대화와 섞지 않는다(스펙 2026-10-28-001 §3-7 ⑤)
      (src === 'all' ||
        (src === 'talk' ? r.source !== 'cron' && r.claude?.purpose !== 'skill-test' : src === 'skill-test' ? r.claude?.purpose === 'skill-test' : r.source === src)) &&
      (!needle || ((r.title ?? '') + ' ' + (r.preview ?? '')).toLowerCase().includes(needle))
  );
  return (
    <>
      <Stack direction="row" spacing={1} sx={{ mb: 1 }}>
        <NativeSelect value={src} onChange={(e) => setSrc(e.target.value)} inputProps={{ 'aria-label': t('chat.sourceLabel') }}>
          {[
            ['talk', t('chat.srcTalk')],
            ['all', t('chat.srcAll')],
            ['aas', 'AAS'],
            ['buzz', t('chat.srcBuzz')],
            ['telegram', t('chat.srcTelegram')],
            ['cli', 'CLI'],
            ['skill-test', t('chat.srcSkillTest')],
            ['cron', newCron ? `${t('chat.srcCron')} (${t('chat.cronNewCount', { n: newCron })})` : t('chat.srcCron')],
          ].map(([v, l]) => (
            <option key={v} value={v}>
              {l}
            </option>
          ))}
        </NativeSelect>
        <TextField
          size="small"
          type="search"
          placeholder={t('chat.searchPlaceholder')}
          value={q}
          onChange={(e) => setQ(e.target.value)}
          slotProps={{ htmlInput: { 'aria-label': t('chat.searchLabel') } }}
          sx={{ flex: 1 }}
        />
      </Stack>
      <ItemList>
        {hit.length ? (
          hit.map((r) => (
            <ItemRow
              key={r.id}
              icon={ChatBubbleOutlineIcon}
              name={r.title || t('chat.untitled')}
              rowTitle={r.preview}
              onRow={async () => {
                try {
                  if (r.source === 'cron') {
                    markCronSeen(r.id);
                    setSeen(seenCron());
                  }
                  await store.resume(r.id, r.claude);
                  if (onPicked) onPicked();
                  else closeDrawer();
                } catch (e) {
                  setError((e as Error).message);
                }
              }}
              tags={
                <>
                  <Tag>{SRC[r.source ?? ''] || r.source || '?'}</Tag>
                  {r.live_session_id ? <Tag tone="good">{t('chat.openNow')}</Tag> : null}
                  {r.claude ? <Tag tone="info">{r.claude.active ? t('chat.claudeActiveTag') : t('chat.claudeTag')}</Tag> : null}
                  {/* 목표·반복이 걸린 대화(스펙 2026-10-27-002 R6). 색 없이 회색 */}
                  {r.control?.loop?.status === 'active' ? <Tag>{t('chat.listLoop')}</Tag> : null}
                  {r.control?.goal?.status === 'active' ? (
                    <Tag>{t('chat.listGoal', { used: r.control.goal.turns_used ?? 0, max: r.control.goal.max_turns ?? 0 })}</Tag>
                  ) : null}
                  {r.source === 'cron' && !seen.has(r.id) ? <Tag tone="warn">{t('chat.cronNew')}</Tag> : null}
                </>
              }
              description={r.preview}
              control={
                <Typography variant="caption" color="text.secondary" sx={{ whiteSpace: 'nowrap' }}>
                  {t('chat.pastMeta', { day: fmtDay(r.started_at), count: r.message_count ?? 0 })}
                </Typography>
              }
            />
          ))
        ) : (
          <ItemEmpty>{t('chat.noPast')}</ItemEmpty>
        )}
      </ItemList>
    </>
  );
}

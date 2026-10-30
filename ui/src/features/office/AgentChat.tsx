/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 장면 안 대화(계획 007 P2): 서랍에서 장면을 보며 에이전트와 말한다. 오피스 경로(/api/office/chat/*)라 방 구성원도 쓸 수 있다.
// 서랍은 한 번에 하나지만, 다른 것을 눌렀다 돌아와도 대화와 입력 초안이 남는다(G11). 답하는 중인 대화는 멈추지 않는다.
import ReplayRoundedIcon from '@mui/icons-material/ReplayRounded';
import { Alert, Box, Button, Checkbox, FormControlLabel, Stack, Typography } from '@mui/material';
import { useEffect, useMemo, useReducer, useRef, useState } from 'react';

import { CommandCard } from '@/components/chat/CommandCard';
import { CommandRows, SlashNote } from '@/components/chat/CommandRows';
import { Composer, ComposerHandle } from '@/components/chat/Composer';
import { CopyButton } from '@/components/chat/CopyButton';
import { ErrorRow } from '@/components/chat/ErrorRow';
import { LostReplyRow } from '@/components/chat/LostReplyRow';
import { MessageRow } from '@/components/chat/MessageRow';
import { answerKeys, ReadAloudButton, readPinned, useReadScope, useReadSnap } from '@/components/chat/ReadAloud';
import { ReconnectRow } from '@/components/chat/ReconnectRow';
import { planSlash, skillSuggestItems, slashItems, slashSource } from '@/components/chat/skillSuggest';
import { useChatTokens } from '@/components/chat/useChatTokens';
import { useMyVoice } from '@/components/chat/VoiceInput';
import { FileBadge } from '@/components/files/FileBadge';
import { Markdown } from '@/components/Markdown';
import type { MarkdownFiles } from '@/components/markdown/Markdown';
import { tier1, tier2 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { backoffDelay, RETRY_MAX_MS, RETRY_MAX_TRIES } from '@/lib/backoff';
import { FLASH_MS } from '@/lib/chatStore';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import { fileSource } from '@/lib/fileKinds';
import { splitPaths } from '@/lib/filePaths';
import { useSkillSuggest } from '@/lib/useSkillSuggest';
import { useConnWait, wsClient } from '@/lib/ws';
import { NoticeLine } from '@/screens/chat/files';
import { AgentAvatar } from '@/screens/chat/parts';

interface Line {
  /** command: 명령 결과 카드, cmdnote: 명령을 실행하지 않은 이유(호박색), divider: 되감은 뒤 한 줄(스펙 2026-10-26-010) */
  role: 'user' | 'assistant' | 'tool' | 'note' | 'skill' | 'command' | 'cmdnote' | 'divider';
  text: string;
  /** role 'command': 명령 이름 */
  command?: string;
  /** role 'user': /retry 로 다시 보낸 원래 질문(DC9) */
  retried?: boolean;
  /** role 'skill': 붙이지 못한 스킬과 이유(스펙 2026-10-19-012 OV-H2) */
  name?: string;
  reason?: string;
  /** role 'assistant': 되묻기의 선택지. 방 기록(글)에는 넣지 않고 화면 언어로 말풍선 아래에 그린다(스펙 2026-10-23-005 디자인 D11) */
  choices?: Choice[];
}
export interface Choice {
  question: string;
  choices: string[];
  multi: boolean;
}
interface Conv {
  lines: Line[];
  draft: string;
  turn: string | null;
  next: number;
  error: string;
  /** 지난 말(GET /api/office/chat/history): 아직 안 읽음 → 읽는 중 → 읽음 | 실패 */
  past: 'none' | 'loading' | 'done' | 'failed';
  /** 연결이 끊겨 다시 읽는 중(스펙 2026-10-20-030 4-7). turn: 같은 차례를 다시 묻는다, history: 서버가 차례를 몰라(404) 기록을 다시 읽는다 */
  retry?: { tries: number; since: number; nextAt: number; kind: 'turn' | 'history' };
  /** 서버가 다시 시작돼 답을 받지 못했다 — 호박색 줄과 「다시 묻기」(DR6) */
  lost?: boolean;
  // ---- 「/」 명령(스펙 2026-10-26-010 §11) ----
  /** /compress 를 기다리기 시작한 시각(ms) */
  compressing?: number;
  compressSlow?: boolean;
  queue?: QueueView['items'];
  queueHeld?: boolean;
  flash?: { text: string; until: number };
  retryFailed?: boolean;
}
interface QueueView {
  items: { id: string; text: string }[];
  held: boolean;
  compressing?: boolean;
}
type OfficeCommandResult =
  | { kind: 'output'; command: string; text: string }
  | { kind: 'turn'; turn: string; text: string; retry?: boolean; messages?: Past['messages'] | null }
  | { kind: 'prefill'; text: string; messages?: Past['messages'] | null }
  | { kind: 'retry_failed'; text: string; messages?: Past['messages'] | null }
  | { kind: 'queued'; count: number }
  | { kind: 'steered' }
  | { kind: 'compress_timeout' };
type OfficeCommandReply = ({ ok: true; result: OfficeCommandResult } | { ok: false; error: { code: string; text: string } }) & { queue?: QueueView };

/** 오피스 명령 답을 대화에 반영한다(순수, 시험용). 채팅의 applyCommand 와 같은 모양 규칙(11-4) */
export function applyOfficeCommand(c: Conv, typed: string, r: OfficeCommandReply, now = Date.now()): void {
  if (r.queue) {
    c.queue = r.queue.items;
    c.queueHeld = r.queue.held;
  }
  c.compressing = 0;
  const rewound = (messages: Past['messages'] | null | undefined, text: string) => {
    if (messages) c.lines = [...pastLines({ messages, turn: null }), { role: 'divider', text }];
  };
  if (!r.ok) {
    const { code, text } = r.error;
    if (code === 'usage' || code === 'empty') {
      c.lines = [...c.lines, { role: 'command', command: typed.split(/\s/)[0], text }];
      if (code === 'empty') c.draft = '';
    } else if (code === 'busy') c.flash = { text, until: now + FLASH_MS };
    else c.lines = [...c.lines, { role: 'cmdnote', text }];
    return;
  }
  const out = r.result;
  if (out.kind === 'output') c.lines = [...c.lines, { role: 'command', command: out.command, text: out.text }];
  else if (out.kind === 'turn') {
    rewound(out.messages, t('chat.cmd.retrying'));
    c.lines = [...c.lines, { role: 'user', text: out.text, ...(out.retry ? { retried: true } : {}) }];
    c.turn = out.turn;
    c.next = 0;
  } else if (out.kind === 'prefill') {
    rewound(out.messages, t('chat.cmd.undone'));
    c.draft = out.text;
    return;
  } else if (out.kind === 'retry_failed') {
    rewound(out.messages, t('chat.cmd.retrying'));
    c.retryFailed = true;
    c.draft = out.text;
    return;
  } else if (out.kind === 'steered') c.flash = { text: t('chat.cmd.steered'), until: now + FLASH_MS };
  else if (out.kind === 'compress_timeout') c.compressSlow = true;
  c.draft = '';
}
interface Past {
  /** choices: 되묻기 물음의 선택지 — 새로 고친 뒤에도 단추를 다시 그린다(스펙 2026-10-23-005 §6) */
  messages: { role: 'user' | 'assistant'; text: string; choices?: Choice[] }[];
  turn: string | null;
  queue?: QueueView;
}
const pastLines = (r: Past): Line[] =>
  r.messages.map((m) => (m.choices?.length ? { role: m.role, text: m.text, choices: m.choices } : { role: m.role, text: m.text }));
interface TurnItem {
  kind: string;
  text?: string;
  /** kind 'notice'(skill_failed): 붙이지 못한 스킬 이름과 이유 */
  name?: string;
  reason?: string;
  /** 토픽으로 받을 때: 이 조각으로 차례가 끝났는가(final·failed) */
  done?: boolean;
  /** kind 'choices': 되묻기 선택지 */
  questions?: Choice[];
}
interface TurnItems {
  items: TurnItem[];
  next: number;
  done: boolean;
  /** 예약한 말(스펙 2026-10-26-010 DC8) */
  queue?: QueueView;
}

// 에이전트별 대화(화면 메모리). 새로 고치면 사라지므로 처음 열 때 서버에서 지난 말을 다시 읽는다 — 대화는 Hermes 의
// office-<사람>-<에이전트> 세션에 남는다. 전에는 읽지 않아 새로 고친 뒤 「아직 나눈 말이 없습니다」만 보였다(2026-10-16 사용자 보고)
const store = new Map<string, Conv>();
const conv = (alias: string): Conv => {
  let c = store.get(alias);
  if (!c) {
    c = { lines: [], draft: '', turn: null, next: 0, error: '', past: 'none' };
    store.set(alias, c);
  }
  return c;
};

export const POLL_MS = 700;

/** 대화 답 조각 토픽 이름(서버 ws._turn_spec). */
export const turnTopic = (alias: string, turn: string) => `office:chat:${alias}:${turn}`;

/** 차례 조각을 대화 줄에 반영한다(순수 함수). */
export function applyItems(
  lines: Line[],
  items: TurnItems['items'],
  words: { tool: (n: string) => string; approval: string }
): Line[] {
  const out = [...lines];
  const lastAssistant = () => {
    const last = out[out.length - 1];
    if (last?.role === 'assistant') return last;
    const line: Line = { role: 'assistant', text: '' };
    out.push(line);
    return line;
  };
  for (const it of items) {
    if (it.kind === 'delta') {
      const l = lastAssistant();
      out[out.length - 1] = { ...l, text: l.text + (it.text ?? '') };
    } else if (it.kind === 'final') {
      const l = lastAssistant();
      out[out.length - 1] = { ...l, text: it.text || l.text };
    } else if (it.kind === 'tool_start') {
      out.push({ role: 'tool', text: words.tool(it.text ?? 'tool') });
    } else if (it.kind === 'choices') {
      // 마지막 답 말풍선에 붙인다 — 따로 된 줄로 두면 뒤의 final 이 말풍선을 새로 만들어 같은 글이 두 번 나온다(재리뷰 R18)
      const l = lastAssistant();
      out[out.length - 1] = { ...l, choices: it.questions ?? [] };
    } else if (it.kind === 'approval') {
      out.push({ role: 'note', text: words.approval });
    } else if (it.kind === 'failed') {
      out.push({ role: 'note', text: it.text ?? '' });
    } else if (it.kind === 'notice') {
      out.push({ role: 'skill', text: '', name: it.name ?? '', reason: it.reason ?? it.text ?? '' });
    }
  }
  return out;
}

/** fill: 대화 팝업(OMAI-1115)처럼 부모 높이를 채운다. 기본은 서랍 안 높이(320px) 고정. */
/** 장면 대화창의 글 안 경로 뱃지(스펙 2026-10-20-002 R2·R4). 방 구성원도 쓰는 창이라 받기는 오피스 경로 — 주인 업로드는 서버가 거절한다 */
function OfficeFile({ alias, path }: { alias: string; path: string }) {
  const name = path.split('/').pop() || path;
  const url = `/api/office/chat/files?alias=${encodeURIComponent(alias)}&path=${encodeURIComponent(path)}`;
  return <FileBadge variant="inline" file={{ name, path, url, source: fileSource(path) }} />;
}

/** 되묻기 선택지(스펙 2026-10-23-005 디자인 D11). 오피스 대화는 물음이 차례를 끝내므로 고른 것을 다음 말로 보낸다 — 그 말이 답이 된다.
 *  마지막 물음만 고를 수 있다(active). 뒤에 내 말이 있거나 답하는 중이면 단추를 막는다. 선택지 글은 에이전트가 쓴 것이라 번역하지 않는다. */
function OfficeChoices({ q, active, onPick }: { q: Choice; active: boolean; onPick: (text: string) => void }) {
  const [picked, setPicked] = useState<string[]>([]);
  return (
    <Box role="group" aria-label={t('office.chatChoicesLabel')} sx={{ mt: 1 }}>
      {q.multi && (
        <Typography variant="body2" sx={{ fontSize: chatType.meta, opacity: 0.8 }}>
          {t('office.chatChoicesMulti')}
        </Typography>
      )}
      <Stack direction="row" spacing={1} useFlexGap flexWrap="wrap" alignItems="center">
        {q.multi
          ? q.choices.map((c) => (
              <FormControlLabel
                key={c}
                label={c}
                disabled={!active}
                control={
                  <Checkbox
                    size="small"
                    checked={picked.includes(c)}
                    onChange={(e) => setPicked((cur) => (e.target.checked ? [...cur, c] : cur.filter((x) => x !== c)))}
                  />
                }
              />
            ))
          : q.choices.map((c) => (
              <Button key={c} variant="outlined" color="inherit" size="small" sx={tier2 as object} disabled={!active} onClick={() => onPick(c)}>
                {c}
              </Button>
            ))}
        {q.multi && (
          <Button
            variant="outlined"
            color="inherit"
            size="small"
            sx={tier1 as object}
            disabled={!active || !picked.length}
            onClick={() => onPick(picked.join(', '))}
          >
            {t('chat.answer')}
          </Button>
        )}
      </Stack>
    </Box>
  );
}

function OfficeAnswer({ alias, text }: { alias: string; text: string }) {
  const files = useMemo<MarkdownFiles>(() => ({ render: (path) => <OfficeFile alias={alias} path={path} /> }), [alias]);
  return <Markdown text={text} files={files} />;
}

/** onLost: 답을 받지 못했거나 다시 읽기를 그만뒀는지 알린다 — 떠 있는 창의 최소화 칩이 빨간 점을 단다(스펙 2026-10-20-030 DR14) */
export function AgentChat({ alias, fill = false, onLost }: { alias: string; fill?: boolean; onLost?: (lost: boolean) => void }) {
  const [, force] = useReducer((n: number) => n + 1, 0);
  const c = conv(alias);
  const end = useRef<HTMLDivElement>(null);
  const words = { tool: (name: string) => t('office.bubbleTool', { name }), approval: t('office.chatApproval') };
  // 오피스 대화는 파일을 받지 않는다(OMAI-1153 D23). 놓으면 무반응 대신 안내한다
  const [noFiles, setNoFiles] = useState(false);

  // 다시 읽기 실패를 하나 센다. 한도(5분·12번)를 넘으면 거짓(스펙 2026-10-20-030 Q1)
  const failOnce = (kind: 'turn' | 'history'): boolean => {
    const now = Date.now();
    const R = c.retry?.kind === kind ? c.retry : (c.retry = { tries: 0, since: now, nextAt: 0, kind });
    R.tries += 1;
    if (R.tries >= RETRY_MAX_TRIES || now - R.since >= RETRY_MAX_MS) {
      c.retry = undefined;
      return false;
    }
    R.nextAt = now + backoffDelay(R.tries);
    return true;
  };
  const kick = useRef<() => void>(() => {});
  const [live, setLive] = useState({ n: 0, text: '' });
  const say = (text: string) => setLive((l) => ({ n: l.n + 1, text }));

  // 처음 열 때 한 번 지난 말을 읽는다. 답하는 중인 차례가 있으면 이어 받는다(차례의 조각은 처음부터 다시 받는다)
  useEffect(() => {
    if (c.past !== 'none' || c.lines.length || c.turn) return;
    c.past = 'loading';
    force();
    get<Past>(`/api/office/chat/history?alias=${encodeURIComponent(alias)}`)
      .then((r) => {
        c.lines = pastLines(r);
        c.turn = r.turn;
        c.next = 0;
        c.past = 'done';
        takeQueue(r.queue);
        force();
      })
      .catch(() => {
        c.past = 'failed';
        force();
      });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias]);

  // 답 조각: 웹소켓이면 토픽 office:chat:<자리>:<차례> 로 받고, 아니면(또는 토픽이 거절·끝나면) HTTP 로 0.7초마다 묻는다.
  // HTTP 는 앞 요청이 끝난 뒤에만 다음을 보낸다 — 응답이 0.7초보다 늦으면 같은 after 로 겹쳐 글자가 두 번 붙을 수 있었다(스펙 2026-10-17-004 D5).
  useEffect(() => {
    const turn = c.turn;
    if (!turn) return undefined;
    let stop = false;
    let timer: number | undefined;
    let topicLive = false;
    const take = (from: number, items: TurnItems['items'], next: number, done: boolean, queue?: QueueView) => {
      if (stop || c.turn !== turn || c.next !== from) return; // 다른 길(토픽·HTTP)이 이미 받았다
      takeQueue(queue);
      if (c.retry?.kind === 'turn') {
        c.retry = undefined; // 다시 읽혔다 — 화면에서는 줄만 사라지고 읽기 프로그램에 한 번 알린다(DR9)
        say(t('office.reconnect.reread'));
      }
      c.lines = applyItems(c.lines, items, words);
      c.next = next;
      if (done) {
        c.turn = null;
        // 예약한 말이 있으면 서버가 곧 다음 차례를 시작한다 — 기록을 다시 읽어 그 차례를 이어 받는다(DC8)
        if (c.queue?.length && !c.queueHeld) followQueue();
      }
      force();
    };
    const unsub = wsClient.usable
      ? wsClient.subscribe(
          turnTopic(alias, turn),
          (data, meta) => {
            const it = (data as { payload?: TurnItem } | null)?.payload;
            if (!it || meta.seq !== c.next + 1) return; // 조각 번호 = 앞에서 받은 조각 수 + 1
            topicLive = true;
            take(c.next, [it], meta.seq, !!it.done);
          },
          () => {
            topicLive = false; // 거절되거나 끝났다 — HTTP 로 이어 받는다
          }
        )
      : undefined;
    const poll = () => {
      if (stop || c.turn !== turn) return;
      if (topicLive && wsClient.state === 'live') {
        timer = window.setTimeout(poll, POLL_MS);
        return;
      }
      const from = c.next;
      get<TurnItems>(`/api/office/chat/turn?alias=${encodeURIComponent(alias)}&turn=${encodeURIComponent(turn)}&after=${from}`)
        .then((r) => take(from, r.items, r.next, r.done, r.queue))
        .catch((e: Error) => {
          if (stop || c.turn !== turn) return;
          const status = e instanceof ApiError ? e.status : 0;
          if (status === 404) {
            // 서버가 다시 시작돼 차례를 모른다 — 차례를 끝내고 기록을 다시 읽는다(D2·D8)
            c.turn = null;
            c.retry = { tries: 0, since: Date.now(), nextAt: 0, kind: 'history' };
            force();
            return;
          }
          if ((!status || status >= 500) && failOnce('turn')) {
            force(); // 같은 차례를 간격을 늘려 다시 묻는다
            return;
          }
          c.error = e.message;
          c.turn = null;
          force();
        })
        .finally(() => {
          if (!stop) timer = window.setTimeout(poll, c.retry?.kind === 'turn' ? Math.max(0, c.retry.nextAt - Date.now()) : POLL_MS);
        });
    };
    timer = window.setTimeout(poll, POLL_MS);
    kick.current = () => {
      window.clearTimeout(timer);
      poll();
    };
    return () => {
      stop = true;
      window.clearTimeout(timer);
      unsub?.();
    };
    // 차례가 바뀔 때만 다시 건다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, c.turn]);

  // 서버가 다시 시작돼 차례를 모를 때(404): 기록을 다시 읽어 답이 오면 줄을 바꾼다. 마지막 줄이 사람 말이면 간격을 늘려 몇 번 더 읽고,
  // 한도를 넘으면 「받지 못했습니다」. 서버는 이때 Hermes 에 기록을 다시 묻는다(relay._reread_if_waiting, D8)
  const retryKind = c.retry?.kind;
  useEffect(() => {
    if (retryKind !== 'history') return undefined;
    let stop = false;
    let timer: number | undefined;
    const again = (why?: string) => {
      if (stop) return;
      if (!failOnce('history')) {
        if (why) c.error = why;
        else c.lost = true;
        force();
        return;
      }
      force();
      timer = window.setTimeout(read, Math.max(0, (c.retry?.nextAt ?? 0) - Date.now()));
    };
    const read = () => {
      get<Past>(`/api/office/chat/history?alias=${encodeURIComponent(alias)}`)
        .then((r) => {
          if (stop) return;
          const last = r.messages[r.messages.length - 1];
          if (r.turn || last?.role === 'assistant') {
            c.lines = pastLines(r);
            c.turn = r.turn;
            c.next = 0;
            c.retry = undefined;
            say(t('office.reconnect.restored'));
            force();
            return;
          }
          again();
        })
        .catch((e: Error) => {
          const status = e instanceof ApiError ? e.status : 0;
          again(!status || status >= 500 ? undefined : e.message);
        });
    };
    kick.current = () => {
      window.clearTimeout(timer);
      read();
    };
    read();
    return () => {
      stop = true;
      window.clearTimeout(timer);
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [alias, retryKind]);

  useEffect(() => {
    end.current?.scrollIntoView?.({ block: 'end' });
  }, [c.lines.length]);

  // 입력창 「/」 스킬(스펙 2026-10-19-012 P4). 자리 별칭으로 그 에이전트·프로파일의 목록을 읽는다
  const skills = useSkillSuggest(`/api/office/chat/skills?alias=${encodeURIComponent(alias)}`);
  const busy = !!c.turn;
  const compressing = !!c.compressing;
  // 「/」: 명령 → 스킬(관리하는 사람만 명령, 스펙 2026-10-26-010 R3·DC13). 답하는 중이면 /steer·/queue 만(DC6)
  const slash = slashItems(skills.data, busy);
  const plan = planSlash(c.draft, skills, skillSuggestItems(skills.data), busy);
  const leadingSlash = /^\s*\//.test(c.draft);
  useEffect(() => {
    if (leadingSlash) skills.open(); // 목록 주소가 바뀌면 skills.open 도 바뀌어 다시 읽는다
  }, [leadingSlash, skills.open]); // eslint-disable-line react-hooks/exhaustive-deps

  const lostNow = !!c.lost || !!c.error;
  useEffect(() => {
    onLost?.(lostNow);
  }, [lostNow]); // eslint-disable-line react-hooks/exhaustive-deps
  // 연결이 끊긴 동안 보내기·멈춤을 막는다(DR1·DR5)
  const connWait = useConnWait();
  const blocked = !!c.retry || connWait;
  /** said: 입력칸 대신 보낼 글(되묻기 선택지 단추). 입력칸의 쓰던 글은 그대로 둔다 */
  const send = (said?: string) => {
    const text = (said ?? c.draft).trim();
    if (!text || blocked || compressing) return;
    if (said === undefined && plan.block) return;
    if (said === undefined && plan.command) {
      runCommand(plan.command.name, plan.command.arg);
      return;
    }
    c.lost = false;
    const skill = said === undefined ? plan.skill : undefined;
    c.lines = [...c.lines, { role: 'user', text }];
    if (said === undefined) c.draft = '';
    c.error = '';
    force();
    post<{ turn: string }>('/api/office/chat/send', skill ? { alias, text, skill } : { alias, text })
      .then((r) => {
        c.turn = r.turn;
        c.next = 0;
        force();
      })
      .catch((e: Error) => {
        c.error = e.message;
        force();
      });
  };
  const stop = () => {
    if (c.turn && !blocked) void post('/api/office/chat/stop', { alias, turn: c.turn }).catch(() => undefined);
  };

  // ---- 「/」 명령(스펙 2026-10-26-010) ----
  function takeQueue(q?: QueueView) {
    if (!q) return;
    c.queue = q.items;
    c.queueHeld = q.held;
    if (q.compressing && !c.compressing) c.compressing = Date.now();
  }
  /** 차례가 끝난 뒤 서버가 예약을 보내며 시작한 새 차례를 찾는다. 몇 번 다시 읽는다 */
  function followQueue(tries = 0) {
    window.setTimeout(() => {
      get<Past>(`/api/office/chat/history?alias=${encodeURIComponent(alias)}`)
        .then((r) => {
          if (c.turn) return; // 그사이 다른 길로 차례를 받았다
          takeQueue(r.queue);
          if (r.turn) {
            c.lines = pastLines(r);
            c.turn = r.turn;
            c.next = 0;
            force();
          } else if (c.queue?.length && !c.queueHeld && tries < 4) followQueue(tries + 1);
          else force();
        })
        .catch(() => undefined);
    }, 500 + tries * 500);
  }
  function runCommand(name: string, arg: string) {
    const typed = `/${name}${arg ? ` ${arg}` : ''}`;
    c.error = '';
    c.retryFailed = false;
    if (name === 'compress') {
      c.compressing = Date.now();
      c.draft = ''; // 최대 180초 기다린다 — 친 글을 그동안 입력창에 두지 않는다
    }
    force();
    post<OfficeCommandReply>('/api/office/chat/command', { alias, command: name, arg })
      .then((r) => applyOfficeCommand(c, typed, r))
      .catch((e: Error) => {
        c.compressing = 0;
        c.lines = [...c.lines, { role: 'cmdnote', text: t('chat.cmd.failed', { error: e.message }) }];
      })
      .finally(() => force());
  }
  const queueOp = (op: 'cancel' | 'drop' | 'send', id?: string) => {
    void post<{ queue: QueueView }>('/api/office/chat/queue', { alias, op, ...(id ? { id } : {}) })
      .then((r) => {
        takeQueue(r.queue);
        if (op === 'send' && !c.turn) followQueue();
        force();
      })
      .catch(() => undefined);
  };

  // 차례가 끝나면 한 번만 알린다(스트리밍 중에는 aria-busy 로 조각 읽기를 막는다, 디자인 리뷰 6-2)
  const prevTurn = useRef<string | null>(null);
  useEffect(() => {
    if (prevTurn.current && !c.turn && c.lines[c.lines.length - 1]?.role === 'assistant')
      setLive((l) => ({ n: l.n + 1, text: t('office.replyArrived', { name: alias }) }));
    prevTurn.current = c.turn;
  }, [c.turn]); // eslint-disable-line react-hooks/exhaustive-deps

  const tk = useChatTokens();
  const composer = useRef<ComposerHandle>(null);
  // 말로 입력은 받는 에이전트와 관계없이 내 에이전트로 받아쓴다 — 오피스 대화의 권한은 방 구성원 기준이라 채팅 권한과 다르다(스펙 2026-10-22-005 R12)
  const voice = useMyVoice();
  // 답 「읽어 주기」도 내 에이전트의 주 프로파일로 읽는다. 내 에이전트가 없으면 단추를 그리지 않는다(스펙 2026-10-28-012 DD13)
  const readTarget = voice && { pod: voice.pod, profile: voice.profile, tts: voice.tts, voices: voice.ttsVoices };
  const readConv = `office:${alias}`;
  useReadScope(readConv);
  const rs = useReadSnap();
  const answers = c.lines.filter((l) => l.role === 'assistant');
  const answerKey = new Map(answerKeys(answers.map((l) => l.text)).map((k, j) => [answers[j], k]));
  // 쓰는 중인 답에는 행동 줄을 그리지 않는다(DD13)
  const writing = c.turn ? answers[answers.length - 1] : undefined;
  const sendAndFocus = () => {
    send();
    composer.current?.focus(); // 보낸 뒤에도 다음에 쓸 곳은 입력칸이다(디자인 리뷰 3-1)
  };

  return (
    <Stack
      spacing={1}
      sx={fill ? { height: '100%', minHeight: 0 } : undefined}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) e.preventDefault();
      }}
      onDrop={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        setNoFiles(true);
      }}
    >
      {noFiles && (
        <Alert severity="info" onClose={() => setNoFiles(false)}>
          {t('office.chatNoFiles')}
        </Alert>
      )}
      <Box
        role="log"
        aria-label={t('office.chatLog')}
        aria-live="polite"
        aria-busy={!!c.turn || undefined}
        sx={fill ? { flex: 1, minHeight: 0, overflowY: 'auto' } : { maxHeight: 320, overflowY: 'auto' }}
      >
        <Box
          aria-live="polite"
          aria-atomic="true"
          sx={{ position: 'absolute', width: 1, height: 1, overflow: 'hidden', clip: 'rect(0 0 0 0)', whiteSpace: 'nowrap' }}
        >
          {live.text + (live.n % 2 ? '\u00A0' : '')}
        </Box>
        {!c.lines.length && (
          <Typography variant="body2" sx={{ color: tk.muted, fontSize: chatType.name }}>
            {t(c.past === 'loading' ? 'chat.loadingPast' : c.past === 'failed' ? 'office.chatPastFailed' : 'office.chatEmpty')}
          </Typography>
        )}
        {c.lines.map((l, i) => {
          const prev = c.lines[i - 1];
          const gap = { mt: i === 0 ? 0 : prev?.role === l.role ? 0.5 : 2 };
          if (l.role === 'user')
            return (
              <Box key={i} sx={gap}>
                <MessageRow
                  side="mine"
                  foot={
                    l.retried ? (
                      <Box component="span" sx={{ display: 'inline-flex', alignItems: 'center', gap: 0.5 }}>
                        <ReplayRoundedIcon aria-hidden="true" sx={{ fontSize: 12 }} />
                        {t('chat.cmd.retryMark')}
                      </Box>
                    ) : undefined
                  }
                >
                  {splitPaths(l.text).map((part, j) => (typeof part === 'string' ? part : <OfficeFile key={j} alias={alias} path={part.path} />))}
                </MessageRow>
              </Box>
            );
          if (l.role === 'assistant')
            return (
              <Box key={i} sx={gap}>
                <MessageRow
                  side="agent"
                  pinActions={readPinned(rs, readConv, answerKey.get(l) ?? '')}
                  actions={
                    l === writing || !l.text ? undefined : (
                      <>
                        <CopyButton text={l.text} />
                        <ReadAloudButton target={readTarget} conv={readConv} msg={answerKey.get(l) ?? ''} name={alias} text={l.text} />
                      </>
                    )
                  }
                  head={
                    prev?.role === 'assistant'
                      ? undefined
                      : { avatar: <AgentAvatar name={alias} size={chatMetrics.rowAvatar} />, name: alias }
                  }
                >
                  <OfficeAnswer alias={alias} text={l.text} />
                  {l.choices?.map((q, j) => (
                    <OfficeChoices
                      key={j}
                      q={q}
                      // 마지막 줄의 물음만 고를 수 있다 — 뒤에 내 말이 오면 이미 답한 물음이다
                      active={i === c.lines.length - 1 && !c.turn && !blocked}
                      onPick={(text) => {
                        send(text);
                        composer.current?.focus();
                      }}
                    />
                  ))}
                </MessageRow>
              </Box>
            );
          if (l.role === 'skill') return <NoticeLine key={i} code="skill_failed" name={l.name} reason={l.reason} />;
          if (l.role === 'command') return <CommandCard key={i} command={l.command ?? ''} text={l.text} />;
          if (l.role === 'cmdnote') return <NoticeLine key={i} code="command" text={l.text} />;
          if (l.role === 'divider')
            return (
              <Box key={i} sx={{ my: 2, display: 'flex', alignItems: 'center', gap: 1.5, color: tk.muted, fontSize: chatType.meta }}>
                <Box sx={{ flex: 1, height: '1px', bgcolor: tk.line }} />
                <span>{l.text}</span>
                <Box sx={{ flex: 1, height: '1px', bgcolor: tk.line }} />
              </Box>
            );
          // 도구·알림 줄: 본문 열 아래 작은 보조 글자
          return (
            <Typography key={i} variant="caption" sx={{ display: 'block', ml: 5, my: 0.5, whiteSpace: 'pre-wrap', color: tk.muted, fontSize: 12 }}>
              {l.text}
            </Typography>
          );
        })}
        {c.lost && (
          <LostReplyRow
            text={t('office.replyLostShort')}
            onAskAgain={() => {
              // 입력 칸이 비었을 때만 마지막 사람 말을 채운다 — 쓰던 글을 덮지 않는다(DR6)
              const lastUser = [...c.lines].reverse().find((l) => l.role === 'user');
              if (!c.draft.trim() && lastUser) c.draft = lastUser.text;
              force();
              composer.current?.focus();
            }}
          />
        )}
        <div ref={end} />
      </Box>
      {c.error && <ErrorRow>{c.error}</ErrorRow>}
      {(c.retry || connWait) && (
        <Box sx={{ mb: -1 }}>
          {c.retry ? (
            <ReconnectRow
              text={t('office.reconnect.reply')}
              short={t('office.reconnect.short')}
              nextAt={c.retry.nextAt}
              compact={fill}
              action={{
                label: t('office.reconnect.readNow'),
                onClick: () => {
                  // 사람이 누르면 한도를 새로 시작한다(DR10)
                  if (c.retry) Object.assign(c.retry, { tries: 0, since: Date.now(), nextAt: 0 });
                  kick.current();
                  force();
                },
              }}
            />
          ) : (
            <ReconnectRow text={t('chat.reconnect.wait')} short={t('chat.reconnect.waitShort')} compact={fill} />
          )}
        </Box>
      )}
      <CommandRows
        compressing={c.compressing}
        compressSlow={c.compressSlow}
        queue={c.queue}
        queueHeld={c.queueHeld}
        flash={c.flash}
        retryFailed={c.retryFailed}
        compact={fill}
        hideGray={!!c.retry || connWait}
        onQueue={queueOp}
        onCheck={() => {
          c.compressSlow = false;
          runCommand('status', '');
        }}
        onDismiss={(w) => {
          if (w === 'retryFailed') c.retryFailed = false;
          if (w === 'compressSlow') c.compressSlow = false;
          force();
        }}
      />
      <Composer
        ref={composer}
        value={c.draft}
        onChange={(v) => {
          c.draft = v;
          force();
        }}
        onSend={sendAndFocus}
        sendOn="enter"
        // 읽는 중에 보내면 지난 말과 겹친다. 답하는 중에는 /steer·/queue 만(DC6)
        canSend={!!c.draft.trim() && (!c.turn || !!plan.command) && c.past !== 'loading' && !blocked && !plan.block && !compressing}
        busy={busy || compressing}
        sendWhileBusy={busy && !!plan.command}
        onStop={stop}
        stopDisabled={blocked || compressing}
        inputLabel={t('office.say')}
        placeholder={t('office.sayHintChat')}
        sendLabel={t('office.send')}
        stopLabel={t('office.chatStop')}
        hint={busy ? t('chat.cmd.busyHint') : t('chat.keyHint')}
        compact={fill}
        note={blocked ? t('chat.reconnect.note') : plan.note ? <SlashNote text={plan.note} warn={plan.warn} /> : undefined}
        suggest={[slashSource(skills, slash)]}
        voice={voice}
        readConv={readConv}
      />
    </Stack>
  );
}

/** 시험용: 저장된 대화를 지운다. */
export const resetChats = () => store.clear();

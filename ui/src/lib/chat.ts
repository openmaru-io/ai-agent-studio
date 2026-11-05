/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 대화의 상태와 이벤트 처리. 서버가 보내는 이벤트(SSE)를 대화 항목으로 바꾼다. 화면과 네트워크에 기대지 않는다.
import { hasKey, t } from '@/i18n';

import { parseNotice } from './attachNotice';
import { FileRef } from './chatFiles';
import { zonedDate } from './format';

export type ItemKind =
  | 'user'
  | 'assistant'
  | 'error'
  | 'divider'
  | 'status'
  | 'reason'
  | 'tool'
  | 'approval'
  | 'clarify'
  | 'files'
  | 'notice'
  | 'command';

export interface Item {
  kind: ItemKind;
  text?: string;
  t?: number;
  // 도구
  id?: string | null;
  name?: string;
  context?: string;
  state?: 'running' | 'done' | 'failed';
  t0?: number;
  ms?: number;
  /** 안전장치(hardline·운영자 거절 규칙)가 이 도구 실행을 막은 이유(스펙 2026-10-24-004) */
  guard?: string;
  // 승인·되묻기
  p?: Record<string, unknown>;
  answered?: string | null;
  /** Hermes 가 요청을 끝냈다(request.cancel 의 이유: timeout·interrupted·session_closed·shutdown·resolved). 카드를 닫고 줄로 보인다(스펙 2026-10-23-005 R4) */
  cancelled?: string | null;
  request_id?: string;
  qid?: string | null;
  /** role 'assistant': 기록의 clarify 도구 줄에서 만든 물음 글(스펙 2026-10-23-005 §7-5) */
  asked?: boolean;
  question?: string;
  choices?: (string | { label?: string; value?: string })[];
  multi?: boolean;
  // 오류 줄의 다시 보내기
  retry?: string;
  // 끊긴 대화의 「다시 열기」
  reopen?: boolean;
  // Hermes 에서 대화를 찾지 못해 다시 열 수 없다 — 「새 대화」(스펙 2026-10-20-030 DR4)
  newChat?: boolean;
  // 대화 파일(OMAI-1153): 보낸 말풍선의 첨부(D4), 결과 칩 묶음(D5), 다시 보내기의 첨부(D21)
  files?: FileRef[];
  total?: number;
  truncated?: boolean;
  turn?: number;
  retryFiles?: string[];
  /** 다시 보낼 때 붙일 스킬(스펙 2026-10-19-012) */
  retrySkill?: string;
  /** aas.notice skill_failed 의 이유(noskill·collision·error·timeout) */
  reason?: string;
  // 작업 폴더 안내 코드(D12)
  code?: string;
  // 지난 대화 경계선의 둘째 줄 안내
  hint?: string;
  /** kind 'command': 명령 결과 카드(스펙 2026-10-26-010 DC2). 이 화면에만 있다 — 다시 열거나 되감으면 사라진다 */
  command?: string;
  /** kind 'user': /retry 로 다시 보낸 원래 질문(DC9) */
  retried?: boolean;
  /** kind 'command': review·refine — 결과는 뒤에서 돌고 나중에 대화에 붙는다(스펙 2026-10-27-002 §4-3) */
  background?: boolean;
  /** kind 'command': 실패한 결과(곁 질문의 error: 답 등) */
  failed?: boolean;
}

/** 목표·반복 상태(aas.control, 스펙 2026-10-27-002 §4-1). Hermes session.control 요약 중 화면이 쓰는 칸만 */
export interface GoalState {
  title?: string;
  status?: string;
  turns_used?: number;
  max_turns?: number;
}
export interface LoopState {
  prompt?: string;
  status?: string;
  next_due_at?: number;
  ticks_fired?: number;
  max_ticks?: number;
}
export interface HeartbeatState {
  status?: string;
  interval_seconds?: number;
  prompt?: string;
}
export interface Control {
  goal?: GoalState | null;
  loop?: LoopState | null;
  /** 다른 곳(데스크톱 등)에서 걸린 heartbeat — AAS 는 보기·끄기만(스펙 2026-10-27-004 R3) */
  heartbeat?: HeartbeatState | null;
  /** 멈춤 뒤 Hermes 가 다음 말까지 쉰다(외부 검토 OV4) */
  resting?: boolean;
}

export interface Session {
  id: string;
  profile: string;
  /** 이 대화가 속한 에이전트(POD id). 채팅은 지금 에이전트(쿠키)와 따로 여러 에이전트와 대화한다(2026-10-19-001 R2) */
  pod?: string;
  title: string;
  items: Item[];
  busy: boolean;
  closed?: boolean;
  streamed?: boolean;
  /** 취소로 닫힌 카드 수. 화면 읽기 알림을 다시 읽게 하는 데 쓴다(스펙 2026-10-23-005 디자인 D9) */
  cancelN?: number;
  unread: number;
  seen: number;
  /** 받은 마지막 이벤트 번호 — 토픽에서 SSE 로 바꿀 때 그 다음부터 받는다 */
  lastSeq?: number;
  /** Hermes 에 저장된 대화 id(session.title 이벤트·resume). 끊긴 그 대화를 다시 연다(스펙 2026-10-20-030 R3) */
  storedId?: string;
  /** 이 대화를 받는 길. topic 이면 웹소켓 연결 대기·서버 번호를 본다 */
  via?: 'topic' | 'sse';
  /** 토픽으로 받기 시작했을 때의 서버 번호(welcome.server). 바뀌면 서버가 다시 시작됐다(R4) */
  epoch?: number;
  /** 다시 잇는 중이면 값이 있다. closed 도 참이다 — openSession 이 closed 로 끊긴 객체를 가린다(C1) */
  reconnect?: Reconnect;
  /** 다음 aas.history 를 목록을 다시 만들지 않고 끝부분만 합친다(재검토 RD2) */
  merging?: boolean;
  // ---- 「/」 명령(스펙 2026-10-26-010 §11) ----
  /** /compress 를 시작한 시각(ms). 서버 이벤트라 새로 고쳐도 남는다(DC4) */
  compressing?: number;
  /** 180초를 넘겼다 — 「아직 줄이는 중일 수 있습니다」 */
  compressSlow?: boolean;
  /** 예약한 말(DC8). hermes: Hermes 대기열에 넘겨 곧 시작한다 — 지울 수 없다(스펙 2026-10-27-002 R5) */
  queue?: { id: string; text: string; hermes?: boolean }[];
  /** 목표·반복(aas.control) */
  control?: Control;
  /** Claude Code 가 연 대화를 화면에서 다시 열었을 때의 상태(스펙 2026-10-28-001 §3-7 ⑤). 실시간이 아니라 열 때·새로 고칠 때 읽는다 */
  claude?: { purpose: string; active: boolean };
  /** 답을 기다리는 곁 질문 수(aas.btw_wait, 3단계 R10) */
  btwWait?: number;
  /** 멈춤으로 보류 중 */
  queueHeld?: boolean;
  /** 서버가 다시 시작돼 사라진 예약 수(호박색 줄) */
  queueLost?: number;
  /** 입력창 위 잠깐 보이는 회색 줄(steer 확인 4초, 바쁨 안내) */
  flash?: { text: string; until: number };
  /** /retry 를 되감았지만 다시 보내지 못했다 — 호박색 줄, 질문은 입력창에(DC9) */
  retryFailed?: boolean;
}

export interface Reconnect {
  tries: number;
  since: number;
  /** 다음 시도 시각(0 이면 지금 시도 중) */
  nextAt: number;
  reason: 'aas' | 'hub';
  /** 웹소켓이 live 가 되기를 기다린다(시도로 세지 않는다) — 화면은 「연결 대기」 */
  waitLive?: boolean;
  /** 탭이 보이지 않아 멈췄다 */
  paused?: boolean;
  /** 지금 요청 중 */
  inflight?: boolean;
}

export interface SessionInfo {
  session_id: string;
  profile: string;
  title?: string;
  running?: boolean;
  closed?: boolean;
  /** resume: 이미 열린 대화를 그대로 썼다 */
  reused?: boolean;
  /** resume: 이번에 aas.history 를 보냈다 — 처음부터 받는다(4-4) */
  history?: boolean;
}

export interface ChatEvent {
  type: string;
  payload?: Record<string, unknown>;
}

export const newSession = (s: SessionInfo): Session => ({
  id: s.session_id,
  profile: s.profile,
  title: s.title || '',
  items: [],
  busy: !!s.running,
  unread: 0,
  seen: 0,
});

export const isAsk = (x: Item): boolean => (x.kind === 'approval' || x.kind === 'clarify') && !x.answered && !x.cancelled;

export const pending = (S?: Session | null): Item[] => (S ? S.items.filter(isAsk) : []);

/** 잠긴 답(clarify.lock 은 목록을 JSON 문자열로 저장한다)을 보일 글로 바꾼다. 건너뛴 질문(null)은 빈 칸 표시 */
const shownAnswer = (v: unknown): string => {
  if (v === null || v === undefined) return '—';
  if (typeof v === 'string' && v.startsWith('[')) {
    try {
      const a = JSON.parse(v);
      if (Array.isArray(a)) return a.join(', ');
    } catch {
      /* 글 그대로 */
    }
  }
  return String(v);
};

const lastOf = (items: Item[], pred: (i: Item) => boolean): Item | undefined => {
  for (let i = items.length - 1; i >= 0; i--) if (pred(items[i])) return items[i];
  return undefined;
};
const tail = (S: Session, kind: ItemKind) => {
  const it = S.items[S.items.length - 1];
  return it && it.kind === kind ? it : null;
};
const str = (v: unknown) => (v == null ? '' : String(v));
/** Hermes 기다림 안내의 머리 기호(agent/chat_completion_wait_notice.py·turn_recovery.py·turn_truncation.py) */
const WAIT_NOTICE = /^[⏳⚠↻]/u;
const MESSAGE_KINDS: Partial<Record<ItemKind, true>> = { assistant: true, tool: true, status: true, reason: true };

/** 기록의 clarify 도구 줄 → 물음 글. 오피스 중계가 멈춘 되묻기는 물음이 assistant 말로 남지 않고 이 줄로만 남는다 —
 *  도구 단계로 두면 다시 연 대화에 물음이 보이지 않았다(스펙 2026-10-23-005 §7-5). 인자가 없으면 80자 미리보기(context) */
function askedText(m: Record<string, any>): string { // eslint-disable-line @typescript-eslint/no-explicit-any
  const args = m.args && typeof m.args === 'object' ? m.args : null;
  if (args && 'questions' in args && !Array.isArray(args.questions)) return ''; // 글로 넘겨 Hermes 가 거절한 호출 — 물음이 가지 않았다
  const qs: unknown[] = Array.isArray(args?.questions) ? args.questions : args?.question ? [args] : [];
  const asks = qs.map((q) => str((q as Record<string, unknown>)?.question)).filter(Boolean);
  return asks.length ? asks.join('\n\n') : args ? '' : str(m.context);
}

/** Hermes 가 시작한 턴의 회색 줄 글. 모르는 까닭은 기본 문구(스펙 2026-10-27-002 R8) */
export function autoLabel(reason: string): string {
  const key = `chat.auto.${reason}`;
  return hasKey(key) ? t(key) : t('chat.auto.notice');
}

/** 저장된 기록(aas.history 의 messages)을 대화 항목으로 */
function historyItems(msgs: Record<string, any>[], S: Session): Item[] { // eslint-disable-line @typescript-eslint/no-explicit-any
  const out: Item[] = [];
  for (const m of msgs) {
    const ts = m.timestamp ? Number(m.timestamp) * 1000 : 0;
    if (m.role === 'user' && m.text) {
      // 첨부 안내 줄은 칩으로 되돌린다(D14) — 다시 연 대화도 실시간 화면과 같은 모양
      const { text, files } = parseNotice(str(m.text));
      out.push({ kind: 'user', text, t: ts, ...(files.length ? { files } : {}) });
      if (!S.title) S.title = (text.split('\n')[0] || files[0]?.name || '').slice(0, 40);
    } else if (m.role === 'auto')
      // Hermes 가 스스로 시작한 턴(서버가 저장된 프롬프트를 까닭으로 바꿔 준다, 스펙 2026-10-27-002 9-5) — 실시간 화면의 aas.turn.auto 와 같은 줄
      out.push({ kind: 'divider', code: 'auto', text: autoLabel(str(m.reason)), t: ts });
    else if (m.role === 'assistant' && m.text) out.push({ kind: 'assistant', text: m.text, t: ts });
    else if (m.role === 'tool' && m.name === 'clarify' && askedText(m)) out.push({ kind: 'assistant', text: askedText(m), t: ts, asked: true });
    else if (m.role === 'tool') {
      // guard: 안전장치가 막은 도구 줄(Hermes 패치 history-tool-guard, 스펙 2026-10-24-004 6절)
      const guard = typeof m.guard === 'string' && m.guard ? m.guard : '';
      out.push({ kind: 'tool', id: null, name: m.name || 'tool', context: m.context || '', state: guard ? 'failed' : 'done', t: ts, ...(guard ? { guard } : {}) });
    }
  }
  return out;
}

/** 저절로 다시 연 대화의 기록을 화면 목록에 합친다(재검토 RD2). 목록의 마지막 사람 말을 기록에서 찾아 그 뒤의 답·도구 말만 더하고,
 *  끊기 전 반쯤 받은 답은 기록의 답으로 바꾼다. 파일 칩·안내·승인 줄은 그대로 둔다. 「지난 대화」 구분선은 넣지 않는다(RD1).
 *  찾지 못하면(기록이 다르다) 목록을 기록으로 바꾼다. 바꿨으면 참 */
function mergeHistory(S: Session, fresh: Item[]): boolean {
  let lastUser = -1;
  for (let i = S.items.length - 1; i >= 0; i--)
    if (S.items[i].kind === 'user') {
      lastUser = i;
      break;
    }
  let k = -1;
  if (lastUser >= 0) for (let i = fresh.length - 1; i >= 0; i--) if (fresh[i].kind === 'user' && fresh[i].text === S.items[lastUser].text) {
    k = i;
    break;
  }
  if (k < 0) {
    S.items = fresh;
    return true;
  }
  const keep = S.items.slice(lastUser + 1).filter((x) => !MESSAGE_KINDS[x.kind]);
  // 화면에 되묻기 카드·답한 줄이 남아 있으면 기록에서 만든 같은 물음 글은 뺀다 — 물음이 두 번 보였다
  const asked = keep.some((x) => x.kind === 'clarify');
  S.items = [...S.items.slice(0, lastUser + 1), ...fresh.slice(k + 1).filter((x) => !(asked && x.asked)), ...keep];
  return false;
}

/** 이벤트 하나를 대화에 반영한다. 처리한 이벤트면 true. */
export function applyEvent(S: Session, ev: ChatEvent): boolean {
  const p = (ev.payload ?? {}) as Record<string, any>; // eslint-disable-line @typescript-eslint/no-explicit-any
  const T = ev.type;
  const n0 = S.items.length;
  const push = (it: Item) => {
    S.items.push(it);
    return it;
  };

  if (T === 'aas.history' && p.rewound) {
    // retry·undo 로 되감은 뒤(DC3): 목록을 비우고 다시 그린다. 「지난 대화」 선 대신 무엇이 일어났는지 한 줄
    const msgs = (p.messages ?? []) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    S.items = historyItems(msgs, S);
    S.merging = false;
    S.retryFailed = false;
    const n = Number(p.turns) || 1;
    const text = p.rewound === 'retry' ? t('chat.cmd.retrying') : n > 1 ? t('chat.cmd.undoneN', { count: n }) : t('chat.cmd.undone');
    push({ kind: 'divider', text, code: 'rewound' });
  } else if (T === 'aas.history' && p.compacted && S.items.length) {
    // 긴 대화 버퍼를 줄인 기록(스펙 2026-10-27-002 R10). 이미 그린 화면은 그대로 둔다 — 새로 연 화면만 이것부터 그린다
    return true;
  } else if (T === 'aas.history') {
    const msgs = (p.messages ?? []) as Record<string, any>[]; // eslint-disable-line @typescript-eslint/no-explicit-any
    const fresh = historyItems(msgs, S);
    if (S.queue?.length) {
      // 다시 연 대화 — 서버가 다시 시작돼 예약한 말이 사라졌다(R10·DC8)
      S.queueLost = S.queue.length;
      S.queue = [];
      S.queueHeld = false;
    }
    if (S.merging) {
      S.merging = false;
      mergeHistory(S, fresh);
      return true;
    }
    for (const it of fresh) push(it);
    if (msgs.length) push({ kind: 'divider', text: t('chat.dividerPastTitle'), hint: t('chat.dividerPastHint'), code: 'past' });
  } else if (T === 'session.title') {
    // 저장된 대화 id — 끊기면 이 대화를 다시 연다(R3). Hermes 자동 제목(첫 턴 뒤)이 있으면 세션 제목으로 쓴다
    if (p.session_id) S.storedId = str(p.session_id);
    if (str(p.title).trim()) S.title = str(p.title).trim().slice(0, 60);
    return true;
  } else if (T === 'aas.reconnect.failed') {
    // 저절로 다시 열기를 그만뒀다(R5). 찾지 못함(404)이면 「새 대화」, 아니면 「다시 열기」(DR4)
    S.busy = false;
    S.closed = true;
    const gone = p.code === 'not_found';
    push({ kind: 'error', text: gone ? t('chat.reopenNotFound') : t('chat.reopenFailed'), ...(gone ? { newChat: true } : { reopen: true }) });
  } else if (T === 'aas.user') {
    S.streamed = false;
    const files = Array.isArray(p.files) ? (p.files as FileRef[]) : [];
    push({ kind: 'user', text: p.text, turn: p.turn, ...(files.length ? { files } : {}), ...(p.retry ? { retried: true } : {}) });
    if (!S.title) S.title = (str(p.text).split('\n')[0] || files[0]?.name || '').slice(0, 40);
    S.busy = true;
  } else if (T === 'aas.files') {
    // 이번 턴에 바뀐 파일(R5·R10). 서버가 정렬·거름·자르기를 마쳤다. 턴 번호로 그 턴의 답 뒤에 둔다(재검토 O-10)
    const it: Item = { kind: 'files', files: (p.files ?? []) as FileRef[], total: Number(p.total) || 0, truncated: !!p.truncated, turn: p.turn };
    const nextUser = S.items.findIndex((x) => x.kind === 'user' && (x.turn ?? 0) > (p.turn ?? 0));
    if (nextUser >= 0) S.items.splice(nextUser, 0, it);
    else push(it);
  } else if (T === 'aas.compress') {
    // /compress 기다림(DC4). start 는 서버 시각(초)
    S.compressing = p.state === 'start' ? (Number(p.at) || Date.now() / 1000) * 1000 : 0;
    S.compressSlow = p.state === 'timeout';
    return true;
  } else if (T === 'aas.control') {
    S.control = { goal: p.goal ?? null, loop: p.loop ?? null, heartbeat: p.heartbeat ?? null, resting: !!p.resting };
    return true;
  } else if (T === 'aas.btw') {
    // 곁 질문 답(스펙 2026-10-27-004 R1·R5). 서버가 답하는 중이면 턴 끝까지 들고 있다 보낸다 — 흐름 가운데 끼지 않는다
    const failed = !!p.failed;
    const text = failed ? `${t('chat.cmd.btwFailed')}\n${str(p.text).replace(/^error:\s*/, '')}` : str(p.text).trim() || t('chat.cmd.btwEmpty');
    push({ kind: 'command', command: `/btw ${str(p.question)}`.trim(), text, ...(failed ? { failed: true } : {}) });
  } else if (T === 'aas.btw_wait') {
    S.btwWait = Number(p.count) || 0;
    if (p.lost) S.flash = { text: t('chat.cmd.btwLost', { count: Number(p.lost) }), until: Date.now() + 8000 };
    return true;
  } else if (T === 'aas.title') {
    if (p.title) S.title = str(p.title).slice(0, 40);
    return true;
  } else if (T === 'aas.turn.auto') {
    // Hermes 가 스스로 시작한 턴(목표 이어 하기·반복 차례·알림). 사용자 말풍선 자리에 회색 한 줄(§4-3) — 색 배지는 쓰지 않는다
    S.streamed = false;
    S.busy = true;
    push({ kind: 'divider', code: 'auto', text: autoLabel(str(p.reason)) });
  } else if (T === 'aas.queue') {
    S.queue = Array.isArray(p.items) ? (p.items as { id: string; text: string; hermes?: boolean }[]) : [];
    S.queueHeld = !!p.held;
    if (S.queue.length) S.queueLost = 0;
    return true;
  } else if (T === 'aas.notice') {
    push({ kind: 'notice', code: str(p.code), ...(p.code === 'skill_failed' ? { name: str(p.name), reason: str(p.reason) } : {}) });
  } else if (T === 'message.start') S.busy = true;
  else if (T === 'message.delta') {
    (tail(S, 'assistant') ?? push({ kind: 'assistant', text: '' })).text += p.text || '';
    S.streamed = true;
  } else if (T === 'message.complete') {
    S.busy = false;
    if (p.status === 'error') push({ kind: 'error', text: p.text || t('chat.errorDefault') });
    else if (p.text && !S.streamed) push({ kind: 'assistant', text: p.text });
    else if (p.text) {
      // 답하는 중에 다른 서버로 다시 열리면 그 뒤의 조각만 온다. 끝 글이 받은 글로 끝나면 앞을 놓친 것 — 전체로 바꾼다(스펙 2026-10-20-030 T11)
      const it = tail(S, 'assistant');
      const full = str(p.text);
      if (it && it.text && full.length > it.text.length && full.endsWith(it.text)) it.text = full;
    }
    S.streamed = false;
    for (const x of S.items) if (x.kind === 'tool' && x.state === 'running') x.state = 'done';
  } else if (T === 'thinking.delta' || T === 'status.update') {
    const txt = T === 'thinking.delta' ? str(p.text).trim() : p.text || p.kind;
    // Hermes 의 thinking.delta 는 무작위 장식 「(⊙_⊙) reflecting...」(KawaiiSpinner)과 기다림 안내(⏳·⚠·↻ 로 시작)를 함께 보낸다. 안내만 남긴다
    if (T === 'thinking.delta' && !WAIT_NOTICE.test(txt)) return false;
    if (txt) {
      const it = tail(S, 'status');
      if (it) it.text = txt;
      else push({ kind: 'status', text: txt });
    }
  } else if (T === 'reasoning.delta') (tail(S, 'reason') ?? push({ kind: 'reason', text: '' })).text += p.text || '';
  else if (T === 'tool.start') {
    S.streamed = false;
    push({
      kind: 'tool',
      id: p.tool_id,
      name: p.name || 'tool',
      context: p.context || '',
      state: 'running',
      t0: Date.now(),
    });
  } else if (T === 'tool.progress') {
    const it =
      lastOf(S.items, (x) => x.kind === 'tool' && x.id === p.tool_id) ??
      lastOf(S.items, (x) => x.kind === 'tool' && x.state === 'running');
    if (it && (p.text || p.label)) it.context = p.text || p.label;
  } else if (T === 'tool.complete') {
    const it = lastOf(S.items, (x) => x.kind === 'tool' && x.id === p.tool_id);
    if (it) {
      const guard = guardBlockReason(p.result);
      it.state = guard || p.error || p.status === 'error' ? 'failed' : 'done';
      it.ms = Date.now() - (it.t0 ?? Date.now());
      if (guard) it.guard = guard;
    }
  } else if (T === 'approval.request') {
    S.streamed = false;
    // 대화를 다시 열면 열린 요청이 다시 온다(스펙 2026-10-23-005 R6). 이미 있는 요청은 다시 넣지 않는다 — 카드가 둘이 됐다(로컬 E2E)
    if (!S.items.some((x) => x.kind === 'approval' && p.request_id && (x.p as Record<string, unknown> | undefined)?.request_id === p.request_id))
      push({ kind: 'approval', p, answered: null });
  } else if (T === 'aas.approval.answered') {
    // 승인 대기열 번호로 카드와 맞춘다 — 둘이 열려 있으면 마지막 카드에 붙던 것(스펙 2026-10-23-005 외부 검토 3번)
    const it = lastOf(
      S.items,
      (x) => x.kind === 'approval' && !x.answered && (!p.request_id || (x.p as Record<string, unknown> | undefined)?.request_id === p.request_id)
    );
    if (it) it.answered = p.choice;
  } else if (T === 'clarify.request') {
    S.streamed = false;
    const locked = (p.answers ?? {}) as Record<string, unknown>; // 다시 연 대화: 이미 잠긴 답은 다시 묻지 않는다(R6)
    for (const q of (p.questions ?? [p]) as Record<string, any>[]) { // eslint-disable-line @typescript-eslint/no-explicit-any
      const rid = p.request_id || q.request_id;
      if (S.items.some((x) => x.kind === 'clarify' && x.request_id === rid && (x.qid || null) === (q.qid || null))) continue; // 다시 온 같은 물음(R6)
      push({
        kind: 'clarify',
        request_id: p.request_id || q.request_id,
        qid: q.qid || null,
        question: q.question,
        choices: q.choices || [],
        multi: !!q.multi_select,
        answered: q.qid && q.qid in locked ? shownAnswer(locked[q.qid]) : null,
      });
    }
  } else if (T === 'aas.request.cancelled') {
    // 이미 답한 카드는 건드리지 않는다 — 답한 뒤 오는 resolved 가 「다른 곳에서 답함」으로 바뀌지 않게(R11)
    let hit = false;
    for (const x of S.items)
      if (
        isAsk(x) &&
        x.kind === p.method &&
        (x.kind === 'approval' ? (x.p as Record<string, unknown> | undefined)?.request_id : x.request_id) === p.request_id
      ) {
        x.cancelled = String(p.reason || 'timeout');
        hit = true;
      }
    if (hit) S.cancelN = (S.cancelN ?? 0) + 1;
  } else if (T === 'aas.clarify.answered') {
    const it = lastOf(
      S.items,
      (x) => x.kind === 'clarify' && x.request_id === p.request_id && (x.qid || null) === (p.question_id || null)
    );
    if (it) it.answered = Array.isArray(p.answer) ? p.answer.join(', ') : String(p.answer);
  } else if (T === 'error') {
    S.busy = false;
    push({ kind: 'error', text: p.message || p.text || JSON.stringify(p) });
  } else if (T === 'aas.disconnected') {
    S.busy = false;
    S.closed = true;
    push({ kind: 'error', text: p.code === 'hub_disconnected' ? t('chat.hubDisconnected') : p.text, reopen: true });
  } else return false;

  for (let i = n0; i < S.items.length; i++) if (!S.items[i].t) S.items[i].t = Date.now();
  return true;
}

// ---- 그리기용 묶음 ----
const STEP: Partial<Record<ItemKind, true>> = { status: true, tool: true, reason: true };

export type Block =
  | { type: 'day'; text: string }
  | { type: 'item'; item: Item; cont: boolean }
  | { type: 'steps'; idx: number; items: Item[]; live: boolean; attach: boolean }
  | { type: 'working' };

const dayOf = (ts: number) => {
  const d = zonedDate(ts);
  const n = zonedDate(Date.now());
  return d.y === n.y && d.m === n.m && d.d === n.d ? t('chat.today') : t('chat.dateLong', d);
};

/** 도구 결과가 안전장치 차단이면 그 이유, 아니면 빈 값(스펙 2026-10-24-004). Hermes 터미널 결과의 status 'blocked' 중
 *  hardline(「BLOCKED (hardline): <이유>.」)과 운영자 거절 규칙(「user-defined deny rule '<규칙>'」)만 본다 —
 *  사용자의 승인 거부·위험 판정 거절은 표시하지 않는다. 결과는 객체나 JSON 글로 온다. */
export function guardBlockReason(result: unknown): string {
  let r = result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      return '';
    }
  }
  if (!r || typeof r !== 'object') return '';
  const { status, error } = r as { status?: unknown; error?: unknown };
  if (status !== 'blocked' || typeof error !== 'string') return '';
  const hard = /^BLOCKED \(hardline\):\s*(.+?)(?:\.\s|\.?$)/s.exec(error);
  if (hard) return hard[1].trim();
  const deny = /user-defined deny rule '([^']+)'/.exec(error);
  return deny ? deny[1] : '';
}

/** 항목을 화면 블록으로 묶는다: 진행 단계는 한 묶음, 날짜가 바뀌면 날짜 줄, 같은 말투가 이어지면 cont. */
export function groupItems(S: Session): Block[] {
  const out: Block[] = [];
  let day = '';
  let prev = '';
  let g: { idx: number; items: Item[] } | null = null;
  let gi = 0;
  let attach = false; // 첨부가 있는 턴의 단계는 펼친 채 시작한다(D15)
  const flush = (live: boolean) => {
    if (g) {
      out.push({ type: 'steps', idx: g.idx, items: g.items, live, attach });
      g = null;
      prev = 'steps';
    }
  };
  for (const it of S.items) {
    if (STEP[it.kind]) {
      g = g ?? { idx: gi++, items: [] };
      g.items.push(it);
      continue;
    }
    flush(false);
    if (it.kind === 'user') attach = !!it.files?.length;
    if (it.t && (it.kind === 'user' || it.kind === 'assistant')) {
      const d = dayOf(it.t);
      if (d !== day) {
        day = d;
        out.push({ type: 'day', text: d });
        prev = '';
      }
    }
    out.push({ type: 'item', item: it, cont: (it.kind === 'user' || it.kind === 'assistant') && prev === it.kind });
    prev = it.kind;
  }
  flush(S.busy);
  if (S.busy && prev !== 'steps' && !pending(S).length) out.push({ type: 'working' });
  return out;
}

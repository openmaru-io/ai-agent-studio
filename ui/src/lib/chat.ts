/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 대화의 상태와 이벤트 처리. 서버가 보내는 이벤트(SSE)를 대화 항목으로 바꾼다. 화면과 네트워크에 기대지 않는다.
import { hasKey, t } from '@/i18n';

import { parseNotice } from './attachNotice';
import { FileRef } from './chatFiles';
import { zonedDate } from './format';
import { isLlmBlocked, isLlmBlockedTool } from './llmBlock';
import { splitContextBlock } from './pageContext';
import { serverClockSkew } from './serverClock';

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
  /** 질문을 보낸 때부터 응답 완료까지 걸린 시간(ms). 그 차례의 마지막 답에만 있다(스펙 2026-11-06-006) */
  elapsedMs?: number;
  /** elapsedMs 의 세부(정수 초, 스펙 2026-11-06-006 5절). 모르는 시간이 있으면 없다 */
  elapsedParts?: ElapsedParts;
  /** 사람 말: 실시간으로 응답 완료를 받았다. 기록과 합칠 때 실시간 응답 시간이 이긴다 */
  doneLive?: boolean;
  /** 사람 말: 기록과 합칠 때 화면의 도구 줄을 잃었다 — 이 차례는 세부 시간을 모른다 */
  lostTools?: boolean;
  // 도구
  id?: string | null;
  name?: string;
  context?: string;
  state?: 'running' | 'done' | 'failed';
  t0?: number;
  /** 도구 시작·사람 말의 서버 시각(초, 이벤트 payload 의 aas_at). 소요 시간(ms)은 이것으로 잰다 — 실행 중 초 세기는 화면 시계(t0)다(OMAI-1868) */
  at0?: number;
  /** 도구 끝의 서버 시각(초). at0 와 함께 있으면 서버 시각으로 잰 도구다 */
  at1?: number;
  ms?: number;
  /** 안전장치(hardline·운영자 거절 규칙)가 이 도구 실행을 막은 이유(스펙 2026-10-24-004) */
  guard?: string;
  /** 오류 줄: LLM 가드가 막은 호출(OMAI-1857 D17). 화면이 모델 변경 요청 단추를 붙인다.
   *  도구 줄: 실패한 도구 결과에 가드 구절이 있다(스펙 2026-11-07-001 E2) — 단계 묶음 뒤에 안내 줄 하나가 붙는다(1A) */
  llmBlocked?: boolean;
  /** 도구 줄: 실패 이유(result.error 첫 줄 80자, 디자인 2D) */
  failReason?: string;
  /** notice oom_restart: 작업공간이 메모리 초과로 다시 시작된 시각·한도(스펙 2026-11-07-001 ①, 디자인 5A) */
  oom?: OomInfo;
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
  /** kind 'user': 보낸 직후 서버 aas.user 를 기다리는 동안 화면이 먼저 그린 말풍선(보내는 중, 이슈 #22). aas.user 가 오면 그 내용으로 바뀐다 */
  pending?: boolean;
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

/** 메모리 초과로 다시 시작한 기록(서버 aas.notice oom_restart·resume 오류 본문의 oom) */
export interface OomInfo {
  finished_at: string;
  limit_memory: string;
}

export interface Session {
  id: string;
  profile: string;
  /** 이 대화가 속한 에이전트(POD id). 채팅은 지금 에이전트(쿠키)와 따로 여러 에이전트와 대화한다(2026-10-19-001 R2) */
  pod?: string;
  title: string;
  items: Item[];
  busy: boolean;
  /** 질문 시각(ms, 화면 시계) — 보내기를 누른 때나 서버 질문 시각(aas_at). 답하는 동안 흐르는 시간을 보여 준다 */
  sentAt?: number;
  /** 실시간으로 받은 답 완료 수 — 알림을 화면 갱신마다 묶어도 「답이 끝났다」를 놓치지 않는다 */
  completed?: number;
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
  /** 보지 않는 대기 대화라 받기를 멈췄다(웹소켓 구독 해제). 다시 열면 lastSeq 다음부터 받는다(OMAI-1863) */
  parked?: boolean;
  /** 토픽으로 받기 시작했을 때의 서버 번호(welcome.server). 바뀌면 서버가 다시 시작됐다(R4) */
  epoch?: number;
  /** 다시 잇는 중이면 값이 있다. closed 도 참이다 — openSession 이 closed 로 끊긴 객체를 가린다(C1) */
  reconnect?: Reconnect;
  /** 다음 aas.history 를 목록을 다시 만들지 않고 끝부분만 합친다(재검토 RD2) */
  merging?: boolean;
  /** 이 번호까지는 지난 이벤트를 따라잡는 중 — 그리지 않고 모았다가 한 번에 그린다. 지난 답이 토큰마다 다시 흘러
   *  새로 답하는 것처럼 보였다 */
  catchUp?: number;
  /** 안전 시한(8초)이 지나 끝 번호에 닿지 못하고 받은 데까지만 그렸다 — 그때의 끝 번호. 입력칸 위 회색 줄로 알린다(스펙 2026-11-06-002 G10) */
  partial?: number;
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
  /** 프로파일이 없어져 끝난 대화(profile_deleted·profile_not_found, 스펙 2026-11-07-001 E5·디자인 3C·R2-4). 다시 열지 않고 입력창을 끈다 */
  ended?: boolean;
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
  /** resume 오류 본문이 준 메모리 초과 원인(재검토 R2-1). 끝내 포기하면 실패 줄 위에 원인 줄을 둔다(디자인 2A) */
  oom?: OomInfo;
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
  /** 서버에 지금 쌓인 마지막 이벤트 번호. 처음부터 받는 화면은 여기까지 모아서 한 번에 그린다 */
  seq?: number;
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

/** 서버가 실어 보낸 시각(aas_at, 초). 다시 받은 이벤트도 처음 시각을 지킨다(스펙 2026-11-06-006) */
const serverAt = (p: Record<string, unknown>): number | undefined =>
  typeof p.aas_at === 'number' ? p.aas_at : undefined;

export interface ElapsedParts {
  model: number;
  mcp: number;
  other: number;
}

/** MCP 도구 이름 「mcp__서버__도구」 — 도구 줄 표시(toolLabel)와 툴팁 MCP 집계가 같이 쓴다 */
export const MCP_TOOL = /^mcp__(.+?)__(.+)$/;
const isMcp = (x: Item) => MCP_TOOL.test(x.name ?? '');

/** 구간들을 합친 길이(겹친 부분은 한 번) */
function unionLength(spans: [number, number][]): number {
  let sum = 0;
  let end = -Infinity;
  for (const [a, b] of [...spans].sort((x, y) => x[0] - y[0])) {
    if (b <= end) continue;
    sum += b - Math.max(a, end);
    end = b;
  }
  return sum;
}

/** 0.5초 미만이라 0 이 되는 도구 시간은 0.1초 단위로 둔다 — 0초면 돌지 않은 것처럼 보인다 */
const underSec = (sec: number, raw: number) => (sec === 0 && raw > 0 ? Math.max(0.1, Math.round(raw * 10) / 10) : sec);

/** 응답 시간의 세부(초): 모델 = 총 − 도구가 돈 시간, 도구는 MCP·그 밖으로 나눈다. 세 값의 합 = 보이는 총 시간
 *  (1초 미만 도구 시간의 소수는 반올림 오차로 본다). 질문·완료·도구 중 하나라도 서버 시각을 모르거나 기록과 합치며 도구를 잃었으면 없다(스펙 2026-11-06-006 R1·R2·R5) */
function splitElapsed(asked: Item, to: number | undefined, totalMs: number, tools: Item[]): ElapsedParts | undefined {
  const from = asked.at0;
  if (from === undefined || to === undefined || asked.lostTools) return undefined;
  if (tools.some((x) => x.at0 === undefined || x.at1 === undefined)) return undefined;
  const spans = (xs: Item[]) =>
    xs.map((x): [number, number] => [Math.max(from, x.at0!), Math.min(to, x.at1!)]).filter(([a, b]) => b > a);
  const mcpRaw = unionLength(spans(tools.filter(isMcp)));
  const bothRaw = unionLength(spans(tools));
  const mcp = Math.round(mcpRaw);
  const both = Math.round(bothRaw);
  const sub1 = totalMs < 1000; // 총이 1초 미만이면 모델도 0.1초 단위 — 정수로 두면 합보다 커졌다
  return {
    model: sub1 ? Math.max(0, Math.round((totalMs / 1000 - bothRaw) * 10) / 10) : Math.round(totalMs / 1000) - both,
    mcp: underSec(mcp, mcpRaw),
    other: underSec(both - mcp, bothRaw - mcpRaw),
  };
}

/** 걸린 시간 글: 1초 미만은 「0.N초」, 1분 미만은 「N초」, 그 위는 「N분 N초」 */
export function elapsedText(ms: number): string {
  if (ms > 0 && ms < 950) return t('chat.secs', { n: (Math.max(100, Math.round(ms / 100) * 100) / 1000).toFixed(1) });
  const s = Math.round(ms / 1000);
  return s < 60 ? t('chat.secs', { n: s }) : t('chat.minSecs', { m: Math.floor(s / 60), s: s % 60 });
}

/** 대화 제목: 사용자 글의 첫 줄(없으면 첫 파일 이름). MindWiki 위젯의 페이지 맥락 블록은 떼고 본다 — 블록 첫 줄이 제목이 되던 일(OMAI-2056) */
function titleOf(text: string, files: FileRef[]): string {
  return (splitContextBlock(text).rest.split('\n')[0] || files[0]?.name || '').slice(0, 40);
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
      if (!S.title) S.title = titleOf(text, files);
    } else if (m.role === 'auto')
      // Hermes 가 스스로 시작한 턴(서버가 저장된 프롬프트를 까닭으로 바꿔 준다, 스펙 2026-10-27-002 9-5) — 실시간 화면의 aas.turn.auto 와 같은 줄
      out.push({ kind: 'divider', code: 'auto', text: autoLabel(str(m.reason)), t: ts });
    else if (m.role === 'assistant' && m.text) out.push({ kind: 'assistant', text: m.text, t: ts });
    else if (m.role === 'tool' && m.name === 'clarify' && askedText(m)) out.push({ kind: 'assistant', text: askedText(m), t: ts, asked: true });
    else if (m.role === 'tool') {
      // guard: 안전장치가 막은 도구 줄(Hermes 패치 history-tool-guard, 스펙 2026-10-24-004 6절)
      const guard = typeof m.guard === 'string' && m.guard ? m.guard : '';
      // llm_blocked·failed: 같은 패치가 실시간과 같은 실패 정의(E8)·가드 구절(E2)로 넘긴다(E1·디자인 2C, 롤아웃 전에는 오지 않는다)
      const llmBlocked = m.llm_blocked === true;
      const failed = !!guard || llmBlocked || m.failed === true;
      out.push({
        kind: 'tool',
        id: null,
        name: m.name || 'tool',
        context: m.context || '',
        state: failed ? 'failed' : 'done',
        t: ts,
        ...(guard ? { guard } : {}),
        ...(llmBlocked && !guard ? { llmBlocked: true } : {}),
      });
    }
  }
  markHistoryElapsed(out, S.busy);
  return out;
}

/** 지난 대화: 차례마다 「마지막 답의 저장 시각 − 질문의 저장 시각」을 마지막 답에 붙인다. 아직 답하는 중인 마지막 차례는 뺀다 */
function markHistoryElapsed(items: Item[], busy: boolean): void {
  let askedAt = 0;
  let last: Item | undefined;
  const close = () => {
    if (last?.t && askedAt && last.t > askedAt) last.elapsedMs = last.t - askedAt;
  };
  for (const it of items) {
    if (it.kind === 'user' || it.kind === 'divider') {
      close();
      askedAt = it.kind === 'user' ? (it.t ?? 0) : 0;
      last = undefined;
    } else if (it.kind === 'assistant' && !it.asked) last = it;
  }
  if (!busy) close();
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
  // 이미 잰 도구 소요 시간을 기록의 도구 줄로 옮긴다 — 기록에는 시간이 없어 다시 이어진 대화에서 사라졌다(OMAI-1868).
  // 같은 순서의 도구 줄을 이름이 같을 때만 짝짓는다
  const liveTools = S.items.slice(lastUser + 1).filter((x) => x.kind === 'tool');
  fresh
    .slice(k + 1)
    .filter((x) => x.kind === 'tool')
    .forEach((x, i) => {
      const old = liveTools[i];
      if (old && old.name === x.name && old.ms !== undefined && x.ms === undefined) x.ms = old.ms;
      if (old && old.name === x.name && old.at0 !== undefined) Object.assign(x, { at0: old.at0, at1: old.at1 });
    });
  // 짝을 못 찾은 화면 도구 줄은 사라진다 — 그 차례의 세부 시간은 모른다(스펙 2026-11-06-006 R5)
  const freshTools = fresh.slice(k + 1).filter((x) => x.kind === 'tool');
  const asker = S.items[lastUser];
  if (liveTools.some((x, i) => freshTools[i]?.name !== x.name)) asker.lostTools = true;
  // 실시간으로 완료를 받은 차례는 실시간 응답 시간이 이긴다 — 기록 저장 시각 차이와 섞이면 총과 세부의 시계가 갈린다(R4)
  if (asker.doneLive) {
    const isAnswer = (x: Item) => x.kind === 'assistant' && !x.asked;
    const live = lastOf(S.items.slice(lastUser + 1), isAnswer);
    const startsTurn = (x: Item) => x.kind === 'user' || (x.kind === 'divider' && x.code === 'auto');
    const turnEnd = fresh.findIndex((x, i) => i > k && startsTurn(x));
    const next = lastOf(fresh.slice(k + 1, turnEnd < 0 ? undefined : turnEnd), isAnswer);
    if (next) Object.assign(next, { elapsedMs: live?.elapsedMs, elapsedParts: live?.elapsedParts });
  }
  // 화면에 되묻기 카드·답한 줄이 남아 있으면 기록에서 만든 같은 물음 글은 뺀다 — 물음이 두 번 보였다
  const asked = keep.some((x) => x.kind === 'clarify');
  S.items = [...S.items.slice(0, lastUser + 1), ...fresh.slice(k + 1).filter((x) => !(asked && x.asked)), ...keep];
  return false;
}

/** 질문 이벤트의 질문 시각(ms, 화면 시계). 서버 시각(aas_at)이 있으면 화면 시계로 옮긴 값,
 *  없으면 실시간은 받은 때(/queue 예약·다른 탭에서 보냄), 따라잡기(새로 고침) 중이면 모름 */
function questionAt(S: Session, ev: ChatEvent): number | undefined {
  const at = serverAt((ev.payload ?? {}) as Record<string, unknown>);
  if (at !== undefined) return at * 1000 - serverClockSkew();
  return S.catchUp ? undefined : Date.now();
}

/** 이벤트 하나를 대화에 반영한다. 처리한 이벤트면 true.
 *  질문 시각(흐르는 시간): 답이 끝났거나(답하는 중 → 아님) Hermes 가 스스로 시작한 차례면 지운다 — 옛 시각부터 세지 않는다.
 *  따라잡기 중에는 마지막 질문으로 덮어쓴다 — 끝 이벤트가 빠진 앞 질문 시각이 남지 않게 */
export function applyEvent(S: Session, ev: ChatEvent): boolean {
  const wasBusy = S.busy;
  const handled = applyOne(S, ev);
  if ((wasBusy && !S.busy) || ev.type === 'aas.turn.auto' || ev.type === 'aas.reconnect.failed') S.sentAt = undefined;
  else if (ev.type === 'aas.user' && (S.sentAt === undefined || S.catchUp)) S.sentAt = questionAt(S, ev);
  return handled;
}

function applyOne(S: Session, ev: ChatEvent): boolean {
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
    if (p.code === 'profile_not_found') endSession(S); // 알림을 놓친 탭(재검토 R2-4) — 지워졌거나 이름이 바뀌었다
    else if (p.code === 'profile_deleting') push({ kind: 'notice', code: 'profile_deleting' }); // 지우는 중(디자인 2E) — 다시 열지 않는다
    else {
      // 메모리 초과로 다시 시작했다면 원인 줄을 실패 줄 위에(디자인 2A)
      if (p.oom && typeof p.oom === 'object') pushOom(S, p.oom as Record<string, unknown>);
      const gone = p.code === 'not_found';
      push({ kind: 'error', text: gone ? t('chat.reopenNotFound') : t('chat.reopenFailed'), ...(gone ? { newChat: true } : { reopen: true }) });
    }
  } else if (T === 'aas.user') {
    S.streamed = false;
    const files = Array.isArray(p.files) ? (p.files as FileRef[]) : [];
    const echo: Item = {
      kind: 'user',
      text: p.text,
      turn: p.turn,
      ...(files.length ? { files } : {}),
      ...(p.retry ? { retried: true } : {}),
      ...(serverAt(p) !== undefined ? { at0: serverAt(p) } : {}),
    };
    // 화면이 먼저 그린 「보내는 중」 말풍선이 있으면 그 자리를 바꾼다 — 같은 말이 두 번 보이지 않게(이슈 #22)
    const mine = S.items.findIndex((x) => x.kind === 'user' && x.pending);
    if (mine >= 0) S.items.splice(mine, 1, { ...echo, t: S.items[mine].t });
    else push(echo);
    if (!S.title) S.title = titleOf(str(p.text), files);
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
  } else if (T === 'aas.notice' && p.code === 'oom_restart') {
    // 메모리 초과로 다시 시작해 다시 연 대화(E6). 앞선 빨간 끊김 줄은 회색 한 줄로 바꾼다(디자인 1C)
    const hub = lastOf(S.items, (x) => x.kind === 'error' && x.code === 'hub_disconnected');
    if (hub) Object.assign(hub, { kind: 'notice', code: 'reconnected', text: undefined, reopen: undefined });
    if (!pushOom(S, p)) return true;
  } else if (T === 'aas.notice') {
    push({ kind: 'notice', code: str(p.code), ...(p.code === 'skill_failed' ? { name: str(p.name), reason: str(p.reason) } : {}) });
  } else if (T === 'message.start') S.busy = true;
  else if (T === 'message.delta') {
    (tail(S, 'assistant') ?? push({ kind: 'assistant', text: '' })).text += p.text || '';
    S.streamed = true;
  } else if (T === 'message.complete') {
    S.completed = (S.completed ?? 0) + 1;
    S.busy = false;
    if (p.status === 'error') pushError(S, p.text || t('chat.errorDefault'));
    else if (p.text && !S.streamed) push({ kind: 'assistant', text: p.text });
    else if (p.text) {
      // 답하는 중에 다른 서버로 다시 열리면 그 뒤의 조각만 온다. 끝 글이 받은 글로 끝나면 앞을 놓친 것 — 전체로 바꾼다(스펙 2026-10-20-030 T11)
      const it = tail(S, 'assistant');
      const full = str(p.text);
      // response_transformed: Hermes 가 스트리밍 뒤에 끝 글을 바꿨다(도구가 완성한 답을 앞에 붙이는 패치 tool-result-verbatim, OMAI-1863) — 끝 글이 정본이다
      if (it && p.response_transformed === true) it.text = full;
      else if (it && it.text && full.length > it.text.length && full.endsWith(it.text)) it.text = full;
    }
    S.streamed = false;
    for (const x of S.items) if (x.kind === 'tool' && x.state === 'running') x.state = 'done';
    // 마지막 질문부터 지금까지를 그 뒤의 마지막 답에 붙인다(Hermes 가 시작한 차례·지난 대화 구분선 뒤는 뺀다)
    const asked = lastOf(S.items, (x) => x.kind === 'user' || x.kind === 'divider');
    const last = lastOf(S.items, (x) => x.kind === 'assistant' || x === asked);
    // 완료에 서버 시각이 있으면 서버 시각끼리 뺀다: 실시간 질문은 at0, 기록으로 만든 질문은 t(저장 시각).
    // 없으면(옛 서버) 화면 시계끼리 뺀다
    const end = serverAt(p);
    const from = asked?.at0 !== undefined ? asked.at0 * 1000 : asked?.t ?? 0;
    const ms = end !== undefined ? Math.round(end * 1000 - from) : Date.now() - (asked?.t ?? 0);
    const done = !p.status || p.status === 'complete'; // 오류(error)·중지(interrupted)는 뺀다
    if (asked?.kind === 'user') asked.doneLive = true;
    if (done && asked?.kind === 'user' && asked.t && last?.kind === 'assistant' && ms > 0) {
      last.elapsedMs = ms;
      const tools = S.items.slice(S.items.indexOf(asked) + 1).filter((x) => x.kind === 'tool');
      const parts = splitElapsed(asked, end, ms, tools);
      if (parts) last.elapsedParts = parts;
    }
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
      ...(serverAt(p) !== undefined ? { at0: serverAt(p) } : {}),
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
      // 실패 판정은 결과 안의 칸으로 한다(E8). 맨 위 p.error·p.status 는 상류 ToolCompletePayload 에 없다 — 해가 없어 대비로만 둔다(외부 검토 M1)
      const o = toolOutcome(p.result, p.error);
      const failed = !!guard || o.failed || !!p.error || p.status === 'error';
      it.state = failed ? 'failed' : 'done';
      // 서버 시각이 있으면 그것으로 잰다 — 다시 받은 이벤트는 한꺼번에 들어와 화면 시각으로는 0초가 됐다(OMAI-1868)
      const at1 = serverAt(p);
      it.ms =
        at1 !== undefined && it.at0 !== undefined
          ? Math.max(0, Math.round((at1 - it.at0) * 1000))
          : Date.now() - (it.t0 ?? Date.now());
      if (at1 !== undefined) it.at1 = at1;
      if (guard) it.guard = guard;
      else if (failed && o.llmBlocked) it.llmBlocked = true;
      if (failed && o.reason) it.failReason = o.reason;
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
    pushError(S, p.message || p.text || JSON.stringify(p));
  } else if (T === 'aas.disconnected' && p.code === 'profile_deleted') {
    // 지우기가 닫은 대화(E5): 다시 열지 않고 「끝남」 줄(디자인 3C)
    S.busy = false;
    S.closed = true;
    endSession(S);
  } else if (T === 'aas.disconnected') {
    S.busy = false;
    S.closed = true;
    const hub = p.code === 'hub_disconnected';
    push({ kind: 'error', text: hub ? t('chat.hubDisconnected') : p.text, reopen: true, ...(hub ? { code: 'hub_disconnected' } : {}) });
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
/** 오류 줄. LLM 가드 거절이면 번역 안내로 바꾸고 llmBlocked 를 단다 — 모델 변경 요청 단추가 붙는다(D17).
 *  예비 모델(fallback)까지 막혀 거절이 연달아 와도 안내는 한 줄(바로 앞 줄이 같은 안내면 넣지 않는다) */
function pushError(S: Session, text: string) {
  if (!isLlmBlocked(text)) {
    S.items.push({ kind: 'error', text });
    return;
  }
  // 턴 단위로 한 번(디자인 1A): 같은 턴에 가드 안내 줄이나 가드에 막힌 도구 줄(묶음 뒤 안내가 붙는다)이 있으면 넣지 않는다
  if (turnItems(S.items).some((x) => x.llmBlocked)) return;
  S.items.push({ kind: 'error', text: t('chat.llmBlocked'), llmBlocked: true });
}

/** 마지막 턴(마지막 사람 말·Hermes 가 시작한 턴 줄 뒤)의 항목 */
function turnItems(items: Item[]): Item[] {
  for (let i = items.length - 1; i >= 0; i--) if (items[i].kind === 'user' || (items[i].kind === 'divider' && items[i].code === 'auto')) return items.slice(i + 1);
  return items;
}

/** 메모리 초과 원인 줄을 넣는다. 같은 기록(finished_at)이면 넣지 않는다 — 다시 받은 이벤트·실패 경로가 겹쳐도 한 번(디자인 1C). 넣었으면 참 */
function pushOom(S: Session, p: Record<string, unknown>): boolean {
  const oom: OomInfo = { finished_at: str(p.finished_at), limit_memory: str(p.limit_memory) };
  if (!oom.finished_at || S.items.some((x) => x.kind === 'notice' && x.code === 'oom_restart' && x.oom?.finished_at === oom.finished_at)) return false;
  S.items.push({ kind: 'notice', code: 'oom_restart', oom });
  return true;
}

/** 프로파일이 없어져 끝난 대화(디자인 3C). 줄은 한 번 */
function endSession(S: Session) {
  S.ended = true;
  if (!S.items.some((x) => x.kind === 'notice' && x.code === 'profile_ended')) S.items.push({ kind: 'notice', code: 'profile_ended' });
}

/** 도구 결과의 실패 판정(E8)과 LLM 가드 막힘(E2). 결과는 객체나 JSON 글로 온다(Hermes 터미널 결과는 JSON — output·exit_code).
 *  실패: success === false · error 가 빈 글이 아님 · exit_code 가 0 이 아닌 수 · status === 'error'. JSON 이 아닌 글은 실패를 알 수 없어
 *  fallbackError(맨 위 p.error)가 있을 때만 실패로 보고 그 글을 output 으로 본다. reason 은 error 첫 줄 80자(디자인 2D) */
export function toolOutcome(result: unknown, fallbackError?: unknown): { failed: boolean; llmBlocked: boolean; reason: string } {
  let r: unknown = result;
  if (typeof r === 'string') {
    try {
      r = JSON.parse(r);
    } catch {
      r = { output: r };
    }
  }
  const o = (r && typeof r === 'object' ? r : {}) as { success?: unknown; error?: unknown; exit_code?: unknown; status?: unknown; output?: unknown; stderr?: unknown };
  const errText = typeof o.error === 'string' && o.error.trim() ? o.error : typeof fallbackError === 'string' ? fallbackError : '';
  const failed =
    o.success === false ||
    (typeof o.error === 'string' && !!o.error.trim()) ||
    (typeof o.exit_code === 'number' && o.exit_code !== 0) ||
    o.status === 'error' ||
    !!fallbackError;
  return {
    failed,
    llmBlocked: isLlmBlockedTool(failed, { error: errText, output: o.output, stderr: o.stderr }),
    reason: failed ? (errText.trim().split('\n')[0] ?? '').trim().slice(0, 80) : '',
  };
}

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
  let blockShown = false; // 이 턴에 LLM 가드 안내가 이미 있다(디자인 1A — 턴 단위로 한 번)
  const flush = (live: boolean) => {
    if (g) {
      out.push({ type: 'steps', idx: g.idx, items: g.items, live, attach });
      // 가드에 막힌 도구가 있으면 접힌 묶음 바깥 바로 뒤에 도구용 안내 줄 하나(디자인 1A·3B)
      const blocked = !blockShown && g.items.find((x) => x.kind === 'tool' && x.llmBlocked);
      if (blocked) {
        blockShown = true;
        out.push({ type: 'item', item: { kind: 'error', llmBlocked: true, code: 'tool_blocked', name: blocked.name, text: t('chat.toolLlmBlocked', { tool: blocked.name || 'tool' }) }, cont: false });
      }
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
    if (it.kind === 'user' || (it.kind === 'divider' && it.code === 'auto')) blockShown = false;
    if (it.kind === 'error' && it.llmBlocked) {
      if (blockShown) continue; // 같은 턴에 안내가 이미 있다
      blockShown = true;
    }
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

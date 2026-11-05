/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 채팅 저장소: 화면을 떠나도 대화가 이어지도록 React 밖에 둔다. 열린 대화마다 받는 길(웹소켓 토픽 또는 EventSource) 하나를 갖는다.
// 연결이 끊긴 대화는 사건이 생길 때만 저절로 다시 연다(스펙 2026-10-20-030 R4·D5): 토픽 구독 거절, 서버 번호(epoch) 바뀜,
// aas.disconnected, SSE 오류, 웹소켓이 HTTP 대체·대체됨·로그인 만료로 바뀜. 웹소켓만 끊긴 것은 WsClient 가 구독을 잇는다.
import { useSyncExternalStore } from 'react';

import { t } from '@/i18n';

import { ApiError, get, post } from './api';
import { backoffDelay, RETRY_MAX_MS, RETRY_MAX_TRIES } from './backoff';
import { applyEvent, ChatEvent, newSession, pending, Reconnect, Session, SessionInfo } from './chat';
import { MAX_FILES, PARALLEL, precheck, sendUpload, Upload } from './chatFiles';
import { wsClient } from './ws';

type Stream = { close(): void };
/** 다시 연 뒤 이 시간 안에 또 끊기면 앞의 횟수를 이어서 센다 — 바로 끊기는 일이 되풀이되면 1초마다 다시 열지 않게 */
const CARRY_MS = 30000;
const NO_TOPIC_STATES = ['fallback-http', 'replaced', 'auth-failed'];

export interface AgentInfo {
  name: string;
  title?: string;
  description?: string;
  running?: boolean | null;
  channels?: string[];
  failed_jobs?: number;
  last_activity?: string | null;
}
export interface ChatStatus {
  configured: boolean;
  /** 이 서버가 대화 파일을 다루는가(OMAI-1153). 참일 때만 첨부 단추를 보인다(서버 판이 섞인 동안 첨부가 조용히 빠지지 않게) */
  files?: boolean;
  /** 파일 주소의 pod 인자(R11). 이 묶음의 에이전트 id */
  pod?: string;
  /** 이 POD 의 주 에이전트(프로파일 이름). 주 에이전트를 쓰는 POD 는 루트 default 를 숨긴다 */
  primary?: string;
  /** 채팅이 먼저 여는 프로파일(2026-10-19-001 R3). 없으면 primary */
  chat_default?: string;
  /** 이 POD 주인의 사람 이름. 에이전트 목록의 이름 옆에 누구의 것인지 보인다(2026-10-18-010). 주인이 없으면 비어 있다 */
  owner_name?: string;
  /** AAS↔Hermes 채팅 웹소켓이 지금 열려 있는가(대화를 보낼 때만 열린다). 말로 입력은 HTTP 라 이 값으로 막지 않는다(스펙 2026-10-22-005 §8-6) */
  connected?: boolean;
  /** 음성 인식이 설정된 설치인가(AAS_STT_MODEL). 거짓이면 마이크 단추를 숨긴다(스펙 2026-10-22-005 R2) */
  stt?: boolean;
  /** 스트리밍 받아쓰기를 쓰는 설치인가(AAS_STT_STREAM_URL)와 그 최대 길이(초). OMAI-1554, 계약 stt-stream-protocol.md §5 */
  stt_stream?: boolean;
  stt_stream_max_seconds?: number;
  /** 답 「읽어 주기」가 설정된 설치인가(AAS_TTS_MODEL·AAS_TTS_VOICES). 거짓이면 [읽어 주기]를 그리지 않는다(스펙 2026-10-28-012 §3-8) */
  tts?: boolean;
  /** 고를 수 있는 목소리(id·이름·성별) */
  tts_voices?: { id: string; name: string | { ko?: string; en?: string }; gender?: string }[];
  error?: string;
  env_file?: string;
  agents: AgentInfo[];
  sessions?: SessionInfo[];
}
/** 채팅 목록의 에이전트 묶음 하나(/api/chat/status?all=1, 2026-10-19-001 R2) */
export interface ChatGroup extends ChatStatus {
  /** 에이전트 이름(HermesAgent displayName). 없으면 빈 값 — 화면은 id 를 쓴다 */
  name?: string;
  /** 지금 에이전트(aas_pod 쿠키)인가 */
  current?: boolean;
  /** 관리자가 나눠 준 남의 에이전트인가 — 묶음 머리에 주인 이름을 보인다 */
  shared?: boolean;
  /** 내가 팀 관리자로 다루는 팀원의 에이전트인가 — 머리에 「내 팀」, 입력 칸 위에 대상 상태 줄(스펙 2026-10-22-001 DD2·DD5) */
  team?: boolean;
  /** ok · error(연결 없음) · stopped(멈춤) · starting(파드 준비 중) */
  state?: 'ok' | 'error' | 'stopped' | 'starting';
  /** 거짓이면 주 프로파일(main)을 아직 만드는 중 */
  primary_ready?: boolean;
}
export interface StoredSession {
  id: string;
  source?: string;
  title?: string;
  preview?: string;
  started_at?: number | string;
  message_count?: number;
  live_session_id?: string | null;
  /** 이 서버가 연 대화의 목표·반복(스펙 2026-10-27-002 R6). 다시 띄운 뒤에는 그 대화를 열어야 보인다 */
  control?: { goal?: { status?: string; turns_used?: number; max_turns?: number } | null; loop?: { status?: string } | null } | null;
  /** Claude Code(토큰)가 연 대화(스펙 2026-10-28-001 §3-7 ⑤). purpose skill-test 는 기본 거름에서 뺀다. active: 마지막 기다리기 뒤 90초 */
  claude?: { purpose: string; active: boolean } | null;
}

/** 「내 주 에이전트」를 뜻하는 이름. 이 이름은 그 에이전트의 채팅 기본 → 주 프로파일로 바꿔 연다(2026-10-19-001 R-LATE L5).
 *  예전에는 'default' 로 넘겨, 채팅 목록에서 진짜 루트를 누른 것과 가르지 못했다 */
export const PRIMARY = '@primary';

const key = (pod: string | undefined, profile: string) => `${pod ?? ''}|${profile}`;

/** 세션 목록 한 줄의 상태. waiting: 되묻기·승인이 내 답을 기다림, running: 답하는 중, done: 끝났고 아직 안 봄, idle: 끝남, closed: 끊김 */
export type SessionState = 'waiting' | 'running' | 'done' | 'idle' | 'closed';
/** 서버 세션 목록(/api/chat/sessions)의 한 줄 */
export interface LiveSessionRow {
  session_id: string;
  pod?: string;
  agent_name?: string;
  profile: string;
  title?: string;
  stored_id?: string;
  created?: number;
  last_at?: number;
  state?: 'waiting' | 'running' | 'idle' | 'closed';
  pending?: string[];
}
/** 채팅 왼쪽 세션 목록의 한 줄(이 탭에서 연 세션 + 서버에만 있는 내 세션) */
export interface SessionRow {
  id: string;
  pod?: string;
  profile: string;
  title: string;
  state: SessionState;
  unread: number;
  /** 마지막 활동(ms) */
  at: number;
  /** 이 탭이 아직 받지 않는 서버 세션 */
  remote?: boolean;
  storedId?: string;
  /** 사용자가 위에 고정한 세션 */
  pinned?: boolean;
}
const DISMISSED_KEY = 'aas-chat-dismissed';
const PINNED_KEY = 'aas-chat-pinned';
function readPinned(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(PINNED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-100) : []);
  } catch {
    return new Set();
  }
}
const lastSegment = (p: string) => p.split(/[\\/]+/).filter(Boolean).pop() ?? p;
/** 목록에 보일 세션 제목: 따옴표·경로를 덜어 읽기 쉽게. 경로·URL 은 마지막 토막만, 60자.
 *  예) 「"G:\공유 드라이브\영업\계약.pdf" 요약해줘」 → 「계약.pdf 요약해줘」 */
export function cleanTitle(raw: string): string {
  let s = (raw || '').replace(/\s+/g, ' ').trim();
  s = s.replace(/["“'‘]([^"”'’]*[\\/][^"”'’]*)["”'’]/g, (_m, p: string) => lastSegment(p));
  // 윈도우 경로는 폴더 이름에 빈칸이 있어도 마지막 토막(파일 이름)만. 끝 따옴표가 잘린 제목도 여기서 풀린다
  s = s.replace(/["“']?[A-Za-z]:\\(?:[^\\\n]*\\)*([^\s\\"”']*)["”']?/g, (_m, f: string) => f);
  s = s.replace(/\S*[\\/]\S+/g, (tok) => {
    const url = /^https?:\/\/([^/\s]+)(\/\S*)?$/.exec(tok);
    if (url) return url[2] && lastSegment(url[2]) ? `${url[1]}/…/${lastSegment(url[2])}` : url[1];
    return /^[\w.-]+\/[\w.-]+$/.test(tok) && tok.length < 16 ? tok : lastSegment(tok);
  });
  if (/^["“].*["”]$/.test(s)) s = s.slice(1, -1);
  return s.length > 60 ? s.slice(0, 59) + '…' : s;
}
function readDismissed(): Set<string> {
  try {
    const v = JSON.parse(localStorage.getItem(DISMISSED_KEY) || '[]');
    return new Set(Array.isArray(v) ? v.filter((x) => typeof x === 'string').slice(-200) : []);
  } catch {
    return new Set();
  }
}

// ---- 보일 이름(스펙 2026-10-19-013) ----
// 프로파일이 하나뿐인 에이전트는 프로파일 이름(main) 대신 에이전트 이름을 보인다. 채팅 목록·대화 머리·답한 사람·팝업·명령 팔레트가 함께 쓴다.
// 에이전트 id(pod)는 어디에도 보이지 않는다(2026-10-19-003) — 이름이 없으면 프로파일 이름으로 돌아간다(리뷰 R2).
type NameSource = Partial<Pick<ChatGroup, 'name' | 'primary' | 'state' | 'primary_ready'>> & { agents?: AgentInfo[] };
const profileTitle = (a: AgentInfo) => a.title || a.name;

/** 프로파일이 하나뿐인가. 준비 중·오류·멈춤이거나 main 을 만드는 중이면 아니다 — 그동안은 대상 프로파일이 바뀔 수 있어 이름을 보인다(R1·DD3) */
export function singleProfile(g: NameSource | null | undefined): boolean {
  return !!g && (!g.state || g.state === 'ok') && g.primary_ready !== false && (g.agents?.length ?? 0) === 1;
}
/** 묶음 머리 이름. 이름이 없으면 주 프로파일 이름, 그것도 없으면 「이름 없는 에이전트」(DD14) */
export function groupLabel(g: NameSource | null | undefined): string {
  return g?.name || g?.primary || t('chat.unnamedAgent');
}
/** 목록 줄·아바타 글자에 보일 이름(R2·DD8) */
export function rowTitle(g: NameSource | null | undefined, a: AgentInfo): string {
  return singleProfile(g) && g?.name ? g.name : profileTitle(a);
}
/** 대화 대상 이름(대화 머리·입력창·팝업, C5). multi: 묶음이 여럿이라 프로파일 앞에 에이전트 이름을 붙인다(2026-10-19-001 D4) */
export function targetTitle(g: NameSource | null | undefined, a: AgentInfo, multi: boolean): string {
  if (singleProfile(g)) return rowTitle(g, a);
  return multi && g?.name ? t('chat.titleWithAgent', { agent: g.name, name: profileTitle(a) }) : profileTitle(a);
}

export class ChatStore {
  /** 지금 고른 묶음(대화 중인 에이전트)의 상태. 목록·대화·파일이 이것을 본다 */
  status: ChatStatus | null = null;
  /** 내 에이전트별 묶음(지금 에이전트가 먼저) */
  groups: ChatGroup[] = [];
  /** 지금 에이전트(aas_pod 쿠키). pod 없이 이름만 넘기는 링크는 이 에이전트를 뜻한다(리뷰 D8) */
  currentPod = '';
  /** 마지막으로 고른 묶음. 목록을 다시 읽을 때(지금 에이전트가 바뀐 뒤) 대화 중이던 에이전트를 그대로 고른다 */
  private selectedPod = '';
  sessions: Record<string, Session> = {};
  /** `<pod>|<프로파일>` → 열린 대화 id. 에이전트마다 main·default 가 있어 이름만으로는 섞인다(발견 1) */
  active: Record<string, string> = {};
  currentId: string | null = null;
  profile = '';
  draft = '';
  /** 세션별 입력 중이던 글. 키는 세션 id, 아직 세션이 없는 새 대화는 `new|<pod>|<프로파일>` */
  private drafts: Record<string, string> = {};
  /** 서버가 알려 준 내 세션들(다른 탭·새로 고침 전에 연 세션 포함) */
  liveRows: LiveSessionRow[] = [];
  /** 목록에서 닫은 세션(이 브라우저에만) */
  private dismissed: Set<string> = typeof localStorage === 'undefined' ? new Set() : readDismissed();
  /** 위에 고정한 세션(이 브라우저에만) */
  pinned: Set<string> = typeof localStorage === 'undefined' ? new Set() : readPinned();
  /** 세션별 마지막 활동 시각(ms) */
  private lastAt: Record<string, number> = {};
  opening = '';
  notice = '';
  version = 0;
  /** 보낼 첨부(OMAI-1153 D6·D13). POD 단위 — 같은 POD 안에서 프로파일을 바꿔도 남고, POD 가 바뀌면 비운다 */
  uploads: Upload[] = [];
  private uploadsPod = '';
  /** 「파일」 서랍에서 지운 파일(POD|경로|크기, D22) — 같은 화면의 칩을 취소선으로 바꾼다 */
  deleted = new Set<string>();
  private listeners = new Set<() => void>();
  private streams = new Map<string, Stream>();
  private loading: Promise<void> | null = null;
  /** 대화 id → 다음 다시 열기 시도 */
  private retryTimers = new Map<string, ReturnType<typeof setTimeout>>();
  /** 대화 id → 마지막으로 다시 연 때의 횟수(CARRY_MS) */
  private recent = new Map<string, { tries: number; since: number; at: number }>();
  private connTimer: ReturnType<typeof setTimeout> | null = null;
  private wasConnWaiting = false;
  /** 숨은 알림 영역에 읽힐 글(DR9·DR12). 상태가 바뀌는 네 순간만 바뀐다 */
  announce = '';
  announceSeq = 0;
  /** 알림이 가리키는 대화 id. 화면은 지금 보는 대화의 알림만 읽힌다(팝업이 여럿이어도 한 번) */
  announceFor = '';

  constructor() {
    // 테스트의 가짜 wsClient 에는 onState 가 없을 수 있다
    wsClient.onState?.(() => this.onWsState());
    if (typeof window !== 'undefined') {
      window.addEventListener('online', () => this.wakeReconnects());
      document.addEventListener('visibilitychange', () => {
        if (document.visibilityState === 'visible') this.wakeReconnects();
      });
    }
  }
  /** 에이전트를 바꿀 때마다 오른다. 바꾸기 전에 나간 상태 요청의 늦은 응답을 버린다(2026-10-19-001 R1) */
  private generation = 0;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getVersion = () => this.version;
  notify() {
    this.version++;
    this.listeners.forEach((fn) => fn());
  }

  current(): Session | null {
    return this.currentId ? this.sessions[this.currentId] ?? null : null;
  }
  sessionOf(profile: string, pod: string | undefined = this.status?.pod): Session | undefined {
    return this.sessions[this.active[key(pod, profile)]];
  }
  waiting(): number {
    return Object.values(this.sessions).filter((S) => (!S.closed || S.reconnect) && pending(S).length).length;
  }

  // ---- 연결 상태(스펙 2026-10-20-030 4-10) ----
  /** 이 대화에 보내기·멈추기·승인 답하기를 막는가: 다시 잇는 중이거나, 토픽으로 받는데 웹소켓 연결을 기다리는 중(DR1·DR5) */
  blocked(S: Session | null | undefined): boolean {
    if (!S) return false;
    return !!S.reconnect || (S.via === 'topic' && !S.closed && !!wsClient.connWaiting?.());
  }
  /** 입력 칸 위 안내 줄. wait = 「연결 대기」(단추 없음), reopen = 「다시 여는 중」(nextAt 이 0 이면 지금 시도 중) */
  reconnectView(S: Session | null | undefined): { mode: 'wait' | 'reopen'; nextAt: number } | null {
    if (!S) return null;
    const R = S.reconnect;
    if (R) return R.waitLive ? { mode: 'wait', nextAt: 0 } : { mode: 'reopen', nextAt: R.inflight ? 0 : R.nextAt };
    if (S.via === 'topic' && !S.closed && wsClient.connWaiting?.()) return { mode: 'wait', nextAt: 0 };
    return null;
  }
  private say(text: string, S?: Session) {
    this.announce = text;
    this.announceFor = S?.id ?? this.currentId ?? '';
    this.announceSeq++;
  }
  agent(name: string): AgentInfo {
    return this.status?.agents.find((a) => a.name === name) ?? { name };
  }
  /** 지금 대화 중인 에이전트의 묶음 */
  group(pod: string | undefined = this.status?.pod): ChatGroup | undefined {
    return this.groups.find((g) => g.pod === pod);
  }
  /** 대화할 에이전트 이름. PRIMARY 는 그 에이전트의 채팅 기본 → 주 프로파일로 바꾼다. 주 에이전트(main)를 쓰는 POD 에는 루트 default 가 없어
   *  서버가 「없는 프로파일」로 거절하므로, 이름이 default 인데 이 POD 의 목록에 없으면 주 에이전트로 바꾼다. 그 밖의 이름은 그대로 둔다 */
  resolve(name: string): string {
    const st = this.status;
    if (name === PRIMARY) return st?.chat_default || st?.primary || 'default';
    if (name !== 'default' || !st?.primary || st.primary === 'default') return name;
    return st.agents.some((a) => a.name === 'default') ? name : st.primary;
  }
  /** 이 에이전트 목록에 없는 이름이면(다른 에이전트의 화면에서 남은 이름) 서버에 묻지 않고 주 에이전트로 연다. 목록을 못 읽었으면 그대로 둔다 */
  private known(name: string): string {
    const agents = this.status?.agents ?? [];
    if (!agents.length || agents.some((a) => a.name === name)) return name;
    const first = [this.status?.chat_default, this.status?.primary].find((n) => n && agents.some((a) => a.name === n));
    return first ?? agents[0].name;
  }
  /** 대화할 묶음을 고른다. 다른 에이전트로 옮기면 첨부를 비운다(OMAI-1153 D6·D13) */
  private select(pod: string | undefined) {
    const g = (pod && this.group(pod)) || this.group(this.currentPod) || this.groups[0];
    if (!g) return;
    this.status = g;
    this.selectedPod = g.pod ?? '';
    if (this.uploadsPod && g.pod !== this.uploadsPod) this.clearUploads();
  }

  // ---- 상태 ----
  async loadStatus() {
    const gen = this.generation;
    let groups: ChatGroup[];
    let current = '';
    try {
      const res = await get<{ pod?: string; groups?: ChatGroup[] } & ChatStatus>('/api/chat/status?all=1');
      // 옛 서버(묶음 없음)는 지금 에이전트 하나를 한 묶음으로 본다
      groups = res.groups ?? [{ ...res, current: true }];
      current = res.pod ?? groups.find((g) => g.current)?.pod ?? groups[0]?.pod ?? '';
    } catch (e) {
      groups = [{ configured: false, error: (e as Error).message, agents: [], sessions: [], current: true }];
    }
    if (gen !== this.generation) return; // 그 사이 에이전트가 바뀌었다 — 옛 에이전트 기준의 목록이다
    for (const g of groups) g.agents ??= [];
    // podChanged 가 status 를 비우므로 마지막으로 고른 묶음을 쓴다 — 잊으면 대화는 b 의 것인데 머리는 a 로 나왔다(2026-10-19 OKE 시험)
    const keep = this.status?.pod || this.selectedPod;
    this.groups = groups;
    this.currentPod = current;
    this.status = null;
    this.select(keep);
    this.notify();
  }

  // ---- 대화 파일 ----
  get pod(): string {
    return this.status?.pod ?? '';
  }
  get filesEnabled(): boolean {
    return !!this.status?.files && !!this.status?.pod;
  }
  uploading(): boolean {
    return this.uploads.some((u) => u.state === 'wait' || u.state === 'up');
  }
  /** 고른 파일을 보낼 첨부에 더하고 차례로 올린다(동시 PARALLEL 개, D7). 화면 검사에 걸리면 실패 칩으로 남긴다. */
  addFiles(files: File[], rejected: { name: string; code: string }[] = []) {
    if (!this.filesEnabled) return;
    this.uploadsPod = this.pod;
    for (const r of rejected)
      this.uploads.push({ key: crypto.randomUUID(), file: new File([], r.name), name: r.name, size: 0, state: 'fail', pct: 0, code: r.code });
    for (const f of files) {
      const code = precheck(f, this.uploads.filter((u) => u.state !== 'fail').length);
      this.uploads.push({ key: crypto.randomUUID(), file: f, name: f.name, size: f.size, state: code ? 'fail' : 'wait', pct: 0, code: code || undefined });
    }
    this.notify();
    this.pump();
  }
  /** 입력 칸에 포커스를 주고, 칸이 비어 있으면 이 글을 채워 달라는 요청(DD10). 화면(Chat)이 composeSeq 를 보고 처리한다 */
  composeOffer = '';
  composeSeq = 0;
  offerCompose(text: string) {
    this.composeOffer = text;
    this.composeSeq++;
    this.notify();
  }
  /** 작업 폴더에 이미 있는 파일을 올리기 없이 첨부로 붙인다(스펙 2026-10-20-002 §3-2 의 2, 외부 검토 F14).
   *  같은 경로가 있으면 'dup', 한 말 10개를 넘으면 'too_many'(DD10 알림은 부르는 쪽) */
  attachExisting(f: { name: string; path: string; size?: number }): 'ok' | 'dup' | 'too_many' | 'off' {
    if (!this.filesEnabled) return 'off';
    if (this.uploads.some((u) => u.path === f.path && u.state !== 'fail')) return 'dup';
    if (this.uploads.filter((u) => u.state !== 'fail').length >= MAX_FILES) return 'too_many';
    this.uploadsPod = this.pod;
    this.uploads.push({ key: crypto.randomUUID(), file: new File([], f.name), name: f.name, size: f.size ?? 0, state: 'done', pct: 100, path: f.path, picked: true });
    this.notify();
    return 'ok';
  }
  private pump() {
    const pod = this.uploadsPod;
    while (this.uploads.filter((u) => u.state === 'up').length < PARALLEL) {
      const next = this.uploads.find((u) => u.state === 'wait' && !u.xhr && !u.retried);
      if (!next) break;
      void sendUpload(pod, next, () => this.notify()).then(() => this.pump());
    }
  }
  retryUpload(key: string) {
    const u = this.uploads.find((x) => x.key === key);
    if (!u || u.state !== 'fail' || !u.size || u.picked) return;
    Object.assign(u, { state: 'wait', code: undefined, retried: false, pct: 0 });
    this.notify();
    this.pump();
  }
  /** × — 올리는 중이면 전송을 멈추고, 끝난 파일은 첨부에서만 뺀다(파일은 「파일」에 남는다, D13). */
  removeUpload(key: string) {
    const u = this.uploads.find((x) => x.key === key);
    u?.xhr?.abort();
    this.uploads = this.uploads.filter((x) => x.key !== key);
    this.notify();
    this.pump();
  }
  clearUploads() {
    for (const u of this.uploads) u.xhr?.abort();
    this.uploads = [];
    this.uploadsPod = '';
    this.notify();
  }
  markDeleted(path: string, size: number) {
    this.deleted.add(`${this.pod}|${path}|${size}`);
    this.notify();
  }
  isDeleted(path: string, size?: number): boolean {
    return this.deleted.has(`${this.pod}|${path}|${size ?? ''}`);
  }
  preload() {
    if (this.status) return Promise.resolve();
    const p: Promise<void> = (this.loading ??= this.loadStatus().finally(() => {
      if (this.loading === p) this.loading = null;
    }));
    return p;
  }

  /** 이미 읽은 목록을 다시 읽는다(주 프로파일 준비가 끝났을 때·준비 중 묶음 갱신). 아직 읽지 않았으면 다음 열기에 맡긴다 */
  refresh() {
    return this.status ? this.loadStatus() : Promise.resolve();
  }

  /** 지금 에이전트(aas_pod)가 바뀌었다. 묶음 순서와 「지금 에이전트」 표시가 바뀌므로 목록을 다시 읽는다. 다른 에이전트와 하던 대화는
   *  닫지 않는다 — 대화마다 에이전트를 들고 있다(2026-10-19-001 R-LATE L1). 바꾸기 전에 나간 상태 요청의 응답은 버린다(R1). */
  podChanged() {
    this.generation++;
    this.loading = null;
    this.status = null;
    this.groups = [];
    this.notify();
  }

  // ---- 대화 열기 ----
  private openSession(info: SessionInfo, pod: string | undefined, storedId?: string): Session {
    let S: Session | undefined = this.sessions[info.session_id];
    // 서버가 다시 시작돼 끊긴 대화는 사용자 Hermes 가 그대로라 「다시 열기」(resume)가 같은 세션 아이디를 돌려준다.
    // 끊긴 객체를 다시 쓰면 끊김 안내가 남고 이벤트도 받지 않으므로 버리고 새로 받는다(OMAI-1248).
    // 저절로 다시 여는 중인 대화는 그 객체를 그대로 쓴다(adopt) — 여기로 오는 것은 사람이 다시 연 경우다.
    if (S?.closed) {
      this.stopReconnect(S);
      this.closeStream(S);
      delete this.sessions[S.id];
      S = undefined;
    }
    if (!S) {
      S = this.sessions[info.session_id] = { ...newSession(info), pod, ...(storedId ? { storedId } : {}) };
      // 웹소켓이 켜져 있으면 토픽 pod:<대화의 pod>:chat:<세션> 으로, 아니면 SSE 로 받는다(OMAI-1100). 이벤트 모양은 같다.
      // 묶음에 pod 가 없는 옛 서버 응답이면 웹소켓이 붙은 지금 에이전트로 본다
      this.listen(S, this.topicFor(S));
    }
    this.active[key(S.pod, S.profile)] = S.id;
    this.lastAt[S.id] ??= Date.now();
    this.dismissed.delete(S.id);
    if (S.profile === this.profile && S.pod === this.status?.pod) {
      this.currentId = S.id;
      S.unread = 0;
    }
    this.notify();
    return S;
  }

  private topicFor(S: Session): boolean {
    return wsClient.usable && !!(S.pod || wsClient.pod) && !NO_TOPIC_STATES.includes(wsClient.state);
  }

  private closeStream(S: Session) {
    this.streams.get(S.id)?.close();
    this.streams.delete(S.id);
  }

  /** 대화 이벤트를 받는다. 받는 길이 끊기는 사건(토픽 거절·SSE 오류)이 생기면 그 대화를 다시 연다(4-3). */
  private listen(S: Session, topic: boolean) {
    this.closeStream(S);
    S.via = topic ? 'topic' : 'sse';
    if (topic) {
      if (wsClient.state === 'live') S.epoch = wsClient.epoch;
      const stream: Stream = { close: () => {} };
      this.streams.set(S.id, stream);
      stream.close = wsClient.subscribe(
        `pod:${S.pod || wsClient.pod}:chat:${S.id}`,
        (data, meta) => {
          if (this.streams.get(S.id) !== stream) return;
          if (meta.seq > (S.lastSeq ?? 0)) S.lastSeq = meta.seq;
          this.onEvent(S, data as ChatEvent);
        },
        () => {
          // 구독이 거절됐다 — 새 서버에는 이 대화가 없다
          if (this.streams.get(S.id) === stream) this.reconnect(S, 'aas');
        }
      );
      return;
    }
    const podArg = S.pod ? `&pod=${encodeURIComponent(S.pod)}` : '';
    const es = new EventSource(`/api/chat/events?session_id=${encodeURIComponent(S.id)}${podArg}${S.lastSeq ? `&after=${S.lastSeq}` : ''}`);
    this.streams.set(S.id, es);
    es.onmessage = (m: { data: string; lastEventId?: string }) => {
      const seq = Number(m.lastEventId);
      if (seq > (S.lastSeq ?? 0)) S.lastSeq = seq;
      try {
        this.onEvent(S, JSON.parse(String(m.data)));
      } catch {
        /* 깨진 줄은 건너뛴다 */
      }
    };
    es.onerror = () => {
      // 브라우저의 자동 재시도에 맡기지 않는다 — 간격을 화면이 정한다(외부 검토 H5)
      if (this.streams.get(S.id) !== es) return;
      this.reconnect(S, 'aas');
    };
  }

  // ---- 다시 열기(스펙 2026-10-20-030 4-2~4-5) ----
  private onWsState() {
    const st = wsClient.state;
    for (const S of Object.values(this.sessions)) {
      if (S.reconnect?.waitLive && st !== 'connecting' && !st.startsWith('retrying')) void this.attempt(S);
      if (S.via !== 'topic' || S.closed) continue;
      if (st === 'live') {
        const ep = wsClient.epoch;
        if (S.epoch && ep && ep !== S.epoch) this.reconnect(S, 'aas'); // 서버가 다시 시작됐다
        else if (!S.epoch) S.epoch = ep;
      } else if (NO_TOPIC_STATES.includes(st)) this.reconnect(S, 'aas'); // 이 탭은 토픽으로 받을 수 없다 — SSE 로 다시 연다
    }
    // 「연결 대기」(DR1): 시작되는 순간 다시 그리고 한 번 알린다
    if (this.connTimer) clearTimeout(this.connTimer);
    this.connTimer = null;
    const at = wsClient.connWaitAt?.() ?? 0;
    if (at > Date.now()) this.connTimer = setTimeout(() => this.onWsState(), at - Date.now());
    const waitingNow = !!wsClient.connWaiting?.() && Object.values(this.sessions).some((S) => S.via === 'topic' && !S.closed);
    if (waitingNow && !this.wasConnWaiting) this.say(t('chat.reconnect.wait'));
    this.wasConnWaiting = waitingNow;
    this.notify();
  }

  private wakeReconnects() {
    for (const S of Object.values(this.sessions)) {
      const R = S.reconnect;
      if (!R) continue;
      R.tries = 0;
      R.paused = false;
      void this.attempt(S);
    }
  }

  /** 이 대화를 계속 잇는가. 세션 여러 개가 함께 돌므로 목록에서 닫지 않은 세션은 모두 잇는다 */
  private ownsActive(S: Session): boolean {
    return this.sessions[S.id] === S && !this.dismissed.has(S.id);
  }

  private stopReconnect(S: Session) {
    const timer = this.retryTimers.get(S.id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(S.id);
    S.reconnect = undefined;
  }

  /** 끊긴 대화를 다시 잇기 시작한다. 이미 잇는 중이면 아무것도 하지 않는다 */
  private reconnect(S: Session, reason: Reconnect['reason']) {
    if (S.reconnect || this.sessions[S.id] !== S) return;
    this.closeStream(S);
    const prev = this.recent.get(S.id);
    const carry = !!prev && Date.now() - prev.at < CARRY_MS;
    S.closed = true;
    S.busy = false;
    S.reconnect = { tries: carry ? prev!.tries : 0, since: carry ? prev!.since : Date.now(), nextAt: 0, reason };
    this.say(t('chat.reconnect.reopening'), S);
    this.notify();
    void this.attempt(S);
  }

  /** 한 번의 시도(4-4): 서버가 살아 있는지 보고 resume 한다. 503·연결 실패는 간격을 늘려 다시, 404 는 바로 포기 */
  private async attempt(S: Session) {
    const R = S.reconnect;
    if (!R || R.inflight || this.sessions[S.id] !== S) return;
    const timer = this.retryTimers.get(S.id);
    if (timer) clearTimeout(timer);
    this.retryTimers.delete(S.id);
    if (!this.ownsActive(S)) {
      // 사람이 그 사이 다른 대화를 열었다 — 이 대화는 끊긴 채 둔다
      S.reconnect = undefined;
      this.notify();
      return;
    }
    if (typeof document !== 'undefined' && document.visibilityState === 'hidden') {
      R.paused = true;
      this.notify();
      return;
    }
    const wsMode = this.topicFor(S);
    if (wsMode && wsClient.state !== 'live') {
      R.waitLive = true; // 웹소켓이 다시 붙기를 기다린다 — 시도로 세지 않는다
      this.notify();
      return;
    }
    R.waitLive = false;
    R.inflight = true;
    this.notify();
    try {
      if (!wsMode) {
        const r = await fetch('/healthz', { cache: 'no-store' });
        if (!r.ok) throw new Error('down');
      }
      let stored = S.storedId;
      if (!stored) {
        const pod = S.pod ? `&pod=${encodeURIComponent(S.pod)}` : '';
        const rows = (await get<{ sessions: StoredSession[] }>('/api/chat/history?profile=' + encodeURIComponent(S.profile) + pod)).sessions;
        stored = rows.find((x) => x.source === 'aas')?.id;
        if (!stored) {
          R.inflight = false;
          return this.giveUp(S, 'not_found');
        }
      }
      const info = await post<SessionInfo>('/api/chat/resume', { profile: S.profile, stored_id: stored, ...(S.pod ? { pod: S.pod } : {}) });
      R.inflight = false;
      if (S.reconnect !== R) return; // 그 사이 그만뒀다
      if (!info?.session_id) throw new Error('no session'); // 잘못된 응답은 실패로 센다
      this.adopt(S, info, stored);
    } catch (e) {
      R.inflight = false;
      if (S.reconnect !== R) return;
      if (e instanceof ApiError && e.status === 404) return this.giveUp(S, 'not_found');
      if (e instanceof ApiError && e.status >= 400 && e.status < 500 && e.status !== 408 && e.status !== 429) return this.giveUp(S, 'expired');
      this.fail(S, R);
    }
  }

  private fail(S: Session, R: Reconnect) {
    R.tries += 1;
    if (R.tries >= RETRY_MAX_TRIES || Date.now() - R.since >= RETRY_MAX_MS) return this.giveUp(S, 'expired');
    const delay = backoffDelay(R.tries);
    R.nextAt = Date.now() + delay;
    this.retryTimers.set(S.id, setTimeout(() => void this.attempt(S), delay));
    this.notify();
  }

  private giveUp(S: Session, code: 'expired' | 'not_found') {
    this.stopReconnect(S);
    applyEvent(S, { type: 'aas.reconnect.failed', payload: { code } });
    this.say(code === 'not_found' ? t('chat.reopenNotFound') : t('chat.reopenFailed'), S);
    this.notify();
  }

  /** resume 결과를 받아들인다. 목록은 그대로 두고(RD2) 받는 길만 다시 연다 */
  private adopt(S: Session, info: SessionInfo, stored: string) {
    const R = S.reconnect!;
    const old = S.id;
    const id = info.session_id;
    this.stopReconnect(S);
    if (id !== old) {
      // Hermes 런타임도 새로 만들어졌다 — 새 아이디로 옮긴다(M4)
      this.closeStream(S);
      delete this.sessions[old];
      S.id = id;
      this.sessions[id] = S;
      for (const k of Object.keys(this.active)) if (this.active[k] === old) this.active[k] = id;
      if (this.lastAt[old]) this.lastAt[id] = this.lastAt[old];
      if (this.drafts[old] !== undefined) this.drafts[id] = this.drafts[old];
      if (this.currentId === old) this.currentId = id;
      this.recent.delete(old);
    }
    this.recent.set(id, { tries: R.tries, since: R.since, at: Date.now() });
    S.storedId = stored;
    S.closed = false;
    S.busy = !!info.running; // 답하는 중이면 보내기를 막는다(M5)
    if (info.history || (!info.reused && info.history === undefined)) {
      // 서버가 기록을 다시 보낸다 — 번호가 1 부터 다시 시작하고, 기록은 목록에 합친다
      S.lastSeq = 0;
      S.merging = true;
    }
    this.listen(S, this.topicFor(S));
    this.say(t('chat.reconnect.reopened'), S);
    this.notify();
  }

  /** 「지금 다시 열기」·포기 뒤 「다시 열기」: 한도를 새로 시작해 바로 시도한다(DR10) */
  reopenNow(S: Session) {
    this.recent.delete(S.id);
    if (S.reconnect) {
      S.reconnect.tries = 0;
      S.reconnect.since = Date.now();
      S.reconnect.paused = false;
      void this.attempt(S);
      return;
    }
    this.reconnect(S, 'aas');
  }

  /** 끊긴 대화의 「다시 열기」: 끊긴 그 대화를 다시 연다(R3). 열린 대화가 없으면 그 에이전트의 가장 최근 AAS 대화를 연다. */
  async reopen() {
    const S = this.current() ?? (this.profile ? this.sessionOf(this.profile) : undefined);
    if (S) return this.reopenNow(S);
    const profile = this.profile;
    if (!profile) return;
    delete this.active[key(this.status?.pod, profile)];
    this.currentId = null;
    await this.openAgent(profile, this.status?.pod);
  }

  private onEvent(S: Session, ev: ChatEvent) {
    if (ev.type === 'aas.disconnected') {
      // 서버와 Hermes 대시보드 사이가 끊겼다. 서버가 스스로 다시 붙으므로 기다리지 않고 다시 연다(R6·D6)
      this.reconnect(S, ev.payload?.code === 'hub_disconnected' ? 'hub' : 'aas');
      return;
    }
    if (!applyEvent(S, ev)) return;
    this.lastAt[S.id] = Date.now();
    if (S.id !== this.currentId && (ev.type === 'message.complete' || ev.type.endsWith('.request'))) S.unread++;
    this.notify();
  }

  private podBody(): { pod?: string } {
    return this.status?.pod ? { pod: this.status.pod } : {};
  }

  async history(profile: string): Promise<StoredSession[]> {
    const pod = this.status?.pod ? `&pod=${encodeURIComponent(this.status.pod)}` : '';
    return (await get<{ sessions: StoredSession[] }>('/api/chat/history?profile=' + encodeURIComponent(profile) + pod)).sessions;
  }

  /** 에이전트를 누르면 열려 있는 대화를, 없으면 가장 최근 AAS 대화를 잇는다. pod 가 없으면 지금 에이전트(링크·팝업, 리뷰 D8). */
  async openAgent(requested: string, pod?: string) {
    await this.preload();
    this.select(pod ?? this.currentPod);
    // 목록에서 고른 이름(pod 있음)은 그대로 연다 — 진짜 루트 default 를 누른 것을 주 에이전트로 바꾸지 않는다(R-LATE L5)
    const name = this.known(pod ? requested : this.resolve(requested));
    this.profile = name;
    this.draft = '';
    this.notice = '';
    const live = this.sessionOf(name);
    this.currentId = live && (!live.closed || live.reconnect) ? live.id : null;
    if (live) live.unread = 0;
    this.notify();
    if (this.currentId) return;
    const at = this.status?.pod;
    this.opening = name;
    this.notify();
    try {
      const prev = (await this.history(name)).find((x) => x.source === 'aas');
      if (prev && this.profile === name && this.status?.pod === at && !this.currentId)
        this.openSession(await post<SessionInfo>('/api/chat/resume', { profile: name, stored_id: prev.id, ...this.podBody() }), at, prev.id);
    } catch (e) {
      this.notice = (e as Error).message;
    }
    if (this.opening === name) this.opening = '';
    this.notify();
  }

  private async startSession(): Promise<Session | null> {
    this.notice = '';                       // 앞선 실패의 안내를 새 대화에 끌고 오지 않는다
    const at = this.status?.pod;
    try {
      return this.openSession(await post<SessionInfo>('/api/chat/session', { profile: this.profile, ...this.podBody() }), at);
    } catch (e) {
      this.notice = (e as Error).message;
      this.notify();
      return null;
    }
  }

  /** 같은 에이전트로 새 대화. 앞 대화는 닫지 않는다 — 세션 목록에 남아 백그라운드에서 계속 답한다 */
  async newChat() {
    if (!this.profile) return;
    await this.startNew(this.profile, this.status?.pod);
  }

  // ---- 세션 목록(세션 중심 채팅) ----
  private draftKey(id: string | null = this.currentId, pod = this.status?.pod, profile = this.profile): string {
    return id ?? `new|${pod ?? ''}|${profile}`;
  }
  /** 입력 칸이 사라질 때(다른 세션으로 옮김) 쓰던 글을 그 세션 몫으로 둔다 */
  stashDraft(id: string | null, pod: string | undefined, profile: string, text: string) {
    const k = this.draftKey(id, pod, profile);
    if (text) this.drafts[k] = text;
    else delete this.drafts[k];
  }
  private restoreDraft() {
    this.draft = this.drafts[this.draftKey()] ?? '';
  }
  /** 에이전트를 골라 새 세션을 시작한다. 앞 세션들은 닫지 않는다. 아직 말이 없는 세션은 목록에 보이지 않는다(sessionRows) */
  startNew(profile: string, pod?: string): Promise<Session | null> {
    // 목록을 이미 읽었으면 고르기는 바로 한다 — 뒤따르는 주소 맞추기가 같은 대상을 보고 다시 열지 않게
    const run = () => {
      this.select(pod ?? this.currentPod);
      this.profile = this.known(pod ? profile : this.resolve(profile));
      this.currentId = null;
      this.notice = '';
      this.restoreDraft();
      this.notify();
      return this.status?.configured ? this.startSession() : Promise.resolve(null);
    };
    return this.status ? run() : this.preload().then(run);
  }
  /** 목록의 세션을 연다. 이 탭이 받는 세션이면 바로, 서버에만 있으면 붙어서 받는다 */
  async focus(id: string): Promise<boolean> {
    await this.preload();
    const S = this.sessions[id];
    if (S) {
      this.select(S.pod);
      this.profile = S.profile;
      this.currentId = S.id;
      this.active[key(S.pod, S.profile)] = S.id;
      S.unread = 0;
      this.notice = '';
      this.restoreDraft();
      this.notify();
      if (S.closed && !S.reconnect) this.reopenNow(S);
      return true;
    }
    const row = this.liveRows.find((r) => r.session_id === id);
    if (!row) return false;
    this.select(row.pod);
    this.profile = row.profile;
    this.currentId = null;
    this.notice = '';
    this.opening = row.profile;
    this.notify();
    try {
      // 저장 id 가 있으면 resume(서버가 열린 세션을 그대로 돌려준다), 없으면 그 세션의 이벤트를 처음부터 받는다
      const info = row.stored_id
        ? await post<SessionInfo>('/api/chat/resume', { profile: row.profile, stored_id: row.stored_id, ...(row.pod ? { pod: row.pod } : {}) })
        : { session_id: row.session_id, profile: row.profile, title: row.title, running: row.state === 'running' };
      const T = this.openSession(info, row.pod, row.stored_id || undefined);
      if (!T.title && row.title) T.title = row.title;
      this.lastAt[T.id] = (row.last_at ?? 0) * 1000 || Date.now();
      this.currentId = T.id;
      this.restoreDraft();
      return true;
    } catch (e) {
      this.notice = (e as Error).message;
      return false;
    } finally {
      this.opening = '';
      this.notify();
    }
  }
  /** 목록에서 세션을 닫는다(받기를 멈추고 목록에서 뺀다). Hermes 의 대화 기록은 남아 「지난 대화」에서 다시 열 수 있다 */
  dismiss(id: string) {
    this.dismissMany([id]);
  }
  /** 여러 세션을 한 번에 닫는다. 서버에도 숨김을 남겨 다른 기기의 목록에서도 빠진다(실패하면 이 브라우저에만) */
  dismissMany(ids: string[]) {
    if (!ids.length) return;
    const byPod = new Map<string, string[]>();
    for (const id of ids) {
      const S = this.sessions[id];
      const pod = S?.pod ?? this.liveRows.find((r) => r.session_id === id)?.pod ?? '';
      byPod.set(pod, [...(byPod.get(pod) ?? []), id]);
      if (S) {
        this.stopReconnect(S);
        this.closeStream(S);
        delete this.sessions[id];
        for (const k of Object.keys(this.active)) if (this.active[k] === id) delete this.active[k];
      }
      delete this.drafts[id];
      this.dismissed.add(id);
      this.pinned.delete(id);
      if (this.currentId === id) {
        this.currentId = null;
        this.restoreDraft();
      }
    }
    const gone = new Set(ids);
    this.liveRows = this.liveRows.filter((r) => !gone.has(r.session_id));
    try {
      localStorage.setItem(DISMISSED_KEY, JSON.stringify([...this.dismissed].slice(-500)));
      localStorage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]));
    } catch {
      /* 이번 화면에서만 닫힌다 */
    }
    for (const [pod, list] of byPod) {
      void post('/api/chat/sessions/hide', { ids: list, ...(pod ? { pod } : {}) }).catch(() => undefined);
    }
    this.notify();
  }
  /** 끝난 세션(실행 중·내 답 필요·고정 제외)을 모두 닫는다. 닫은 수를 돌려준다 */
  dismissFinished(): number {
    const ids = this.sessionRows()
      .filter((r) => r.state !== 'running' && r.state !== 'waiting' && !r.pinned && r.id !== this.currentId)
      .map((r) => r.id);
    this.dismissMany(ids);
    return ids.length;
  }
  /** 세션을 목록 위에 고정하거나 푼다 */
  togglePin(id: string) {
    if (this.pinned.has(id)) this.pinned.delete(id);
    else this.pinned.add(id);
    try {
      localStorage.setItem(PINNED_KEY, JSON.stringify([...this.pinned]));
    } catch {
      /* 이번 화면에서만 */
    }
    this.notify();
  }
  /** AI 에이전트(`pod|프로파일`)별 살아 있는 세션 수 — 에이전트 칸의 배지 */
  countsByAgent(): Record<string, { running: number; waiting: number; total: number }> {
    const out: Record<string, { running: number; waiting: number; total: number }> = {};
    for (const r of this.sessionRows()) {
      const c = (out[key(r.pod, r.profile)] ??= { running: 0, waiting: 0, total: 0 });
      c.total += 1;
      if (r.state === 'running') c.running += 1;
      if (r.state === 'waiting') c.waiting += 1;
    }
    return out;
  }
  /** 서버의 내 세션 목록을 다시 읽는다(화면 진입·창 포커스·주기) */
  async loadSessions() {
    try {
      const res = await get<{ sessions?: LiveSessionRow[] }>('/api/chat/sessions');
      this.liveRows = res.sessions ?? [];
    } catch {
      return; // 옛 서버(라우트 없음)·일시 오류: 이 탭의 세션만 보인다
    }
    this.notify();
  }
  /** 세션 하나의 목록 상태 */
  stateOf(S: Session): SessionState {
    if (S.closed && !S.reconnect) return 'closed';
    if (pending(S).length) return 'waiting';
    if (S.busy || S.compressing) return 'running';
    return S.unread ? 'done' : 'idle';
  }
  /** 왼쪽 세션 목록: 이 탭의 세션 + 서버에만 있는 내 세션. 순서는 내 답 필요 → 답하는 중 → 최근 활동 */
  sessionRows(): SessionRow[] {
    const rows: SessionRow[] = [];
    const seen = new Set<string>();
    for (const S of Object.values(this.sessions)) {
      // 말이 없는 세션(에이전트만 고른 새 세션)은 지금 보는 것만 보인다 — 빈 세션이 목록에 쌓이지 않게
      if (this.dismissed.has(S.id) || (!S.items.length && !S.title && S.id !== this.currentId)) continue;
      seen.add(S.id);
      if (S.storedId) seen.add('stored:' + S.storedId);
      rows.push({ id: S.id, pod: S.pod, profile: S.profile, title: cleanTitle(S.title), state: this.stateOf(S), unread: S.unread, at: this.lastAt[S.id] ?? 0, storedId: S.storedId, pinned: this.pinned.has(S.id) });
    }
    for (const r of this.liveRows) {
      if (seen.has(r.session_id) || (r.stored_id && seen.has('stored:' + r.stored_id)) || this.dismissed.has(r.session_id) || r.state === 'closed') continue;
      if (!r.title && r.state === 'idle') continue; // 아직 말을 보내지 않은 빈 세션
      if (this.sessions[r.session_id]) continue; // 이 탭이 받는 빈 세션
      rows.push({
        id: r.session_id,
        pod: r.pod,
        profile: r.profile,
        title: cleanTitle(r.title || ''),
        state: r.state === 'running' || r.state === 'waiting' ? r.state : 'idle',
        pinned: this.pinned.has(r.session_id),
        unread: 0,
        at: (r.last_at ?? r.created ?? 0) * 1000,
        remote: true,
        storedId: r.stored_id || undefined,
      });
    }
    const rank: Record<SessionState, number> = { waiting: 0, running: 1, done: 2, idle: 2, closed: 3 };
    return rows.sort((a, b) => rank[a.state] - rank[b.state] || b.at - a.at);
  }

  /** 지금 대화의 입력창에 글을 채워 둔다(새 대화를 열지 않는다). 보내기는 사람이 누른다. */
  fillDraft(text: string) {
    this.draft = text;
    this.notify();
  }

  /** 새 대화를 열고 입력창에 글을 채워 둔다. 보내기는 사람이 누른다. pod 가 없으면 지금 에이전트(링크·AI 단추, 리뷰 D8).
   *  채팅 링크의 pod 가 있으면 그 묶음으로 열고 이름은 그대로 쓴다(스펙 2026-10-28-014 외부 검토 H2) */
  async ask(requested: string, text: string, pod?: string) {
    await this.preload();
    this.select(pod ?? this.currentPod);
    if (!this.status?.configured) return;
    if (!text) return this.openAgent(requested, pod);
    const profile = pod ? requested : this.resolve(requested);
    this.profile = profile;
    this.currentId = null;
    delete this.active[key(this.status?.pod, profile)];
    this.draft = text;
    this.notify();
    await this.startSession();
  }

  /** 채팅 링크의 저장된 대화(session)를 연다. openAgent 의 「가장 최근 대화 잇기」를 건너뛰고 묶음·이름만 정한 뒤 그 대화를 잇는다
   *  (스펙 2026-10-28-014 외부 검토 C1). 같은 대화가 열려 있으면 그것을 쓴다. 실패하면 안내를 남기고 거짓을 돌려준다 */
  async openStored(requested: string, pod: string | undefined, storedId: string): Promise<boolean> {
    await this.preload();
    this.select(pod ?? this.currentPod);
    const name = this.known(pod ? requested : this.resolve(requested));
    this.profile = name;
    this.draft = '';
    this.notice = '';
    const live = this.sessionOf(name);
    const same = live && live.storedId === storedId && (!live.closed || live.reconnect);
    this.currentId = same ? live.id : null;
    if (same) live.unread = 0;
    this.notify();
    if (same) return true;
    const at = this.status?.pod;
    this.opening = name;
    this.notify();
    let ok = true;
    try {
      await this.resume(storedId);
    } catch (e) {
      ok = false;
      if (this.profile === name && this.status?.pod === at) this.notice = t('chat.linkSessionFailed', { error: (e as Error).message });
    }
    if (this.opening === name) this.opening = '';
    this.notify();
    return ok;
  }

  async resume(storedId: string, claude?: { purpose: string; active: boolean } | null) {
    const at = this.status?.pod;
    const S = this.openSession(await post<SessionInfo>('/api/chat/resume', { profile: this.profile, stored_id: storedId, ...this.podBody() }), at, storedId);
    if (claude) {
      S.claude = claude;
      this.notify();
    }
    return S;
  }

  /** Claude Code 가 아직 쓰는 중인지 다시 읽는다(「쓰는 중」 띠의 새로 고침, §3-7 ⑤). 목록에 없으면 띠를 내린다 */
  async refreshClaude(S: Session) {
    if (!S.storedId) return;
    const row = (await this.history(S.profile)).find((r) => r.id === S.storedId);
    S.claude = row?.claude ?? undefined;
    this.notify();
  }

  // ---- 보내기 ----
  /** 올리기가 끝나지 않았으면 보내지 않는다(단추·Enter 가 같은 판정, D8). retryFiles 는 실패한 메시지를 다시 보낼 때의 첨부(D21). */
  /** skill: 입력창이 고른 스킬(스펙 2026-10-19-012 R7). 글은 친 그대로 보내고 서버가 그 낱말만 떼어 펼친다 */
  /** 'rejected': 서버가 첨부 하나를 거절했다(400 + path) — 보내지 않은 것으로 보고 글·첨부를 그대로 두고 그 뱃지만 실패로(DD5) */
  /** 'reconnecting': 다시 잇는 중이거나 연결을 기다리는 중이라 보내지 않았다(Q2). 글·첨부는 그대로 둔다 */
  async send(raw: string, retryFiles?: string[], skill?: string): Promise<'sent' | 'busy' | 'empty' | 'failed' | 'uploading' | 'rejected' | 'reconnecting'> {
    if (this.blocked(this.current())) return 'reconnecting';
    const text = raw.trim();
    if (retryFiles === undefined && this.uploading()) return 'uploading';
    const files = retryFiles ?? this.uploads.filter((u) => u.state === 'done' && u.path).map((u) => u.path as string);
    if ((!text && !files.length) || !this.profile) return 'empty';
    let S = this.current();
    if (S?.busy) return 'busy';
    if (!S || S.closed) {
      S = await this.startSession();
      if (!S) return 'failed';
    }
    this.draft = '';
    const kept = this.uploads;
    if (retryFiles === undefined) this.uploads = this.uploads.filter((u) => u.state === 'fail');
    const pod = S.pod ? { pod: S.pod } : {};
    try {
      const sk = skill ? { skill } : {};
      await post('/api/chat/send', files.length ? { session_id: S.id, text, files, ...pod, ...sk } : { session_id: S.id, text, ...pod, ...sk });
      return 'sent';
    } catch (e) {
      S.busy = false;
      const bad = e instanceof ApiError && e.status === 400 && typeof e.data.path === 'string' ? (e.data.path as string) : '';
      if (bad && retryFiles === undefined && kept.some((u) => u.path === bad)) {
        this.uploads = kept.map((u) => (u.path === bad ? { ...u, state: 'fail' as const, code: String(e instanceof ApiError ? e.data.code || 'unknown' : 'unknown') } : u));
        this.draft = raw;
        this.notify();
        return 'rejected';
      }
      S.items.push({
        kind: 'error',
        text: t('chat.sendFailed', { error: (e as Error).message }),
        retry: text || ' ',
        ...(files.length ? { retryFiles: files } : {}),
        ...(skill ? { retrySkill: skill } : {}),
        t: Date.now(),
      });
      this.notify();
      return 'failed';
    }
  }

  /** quiet: 실패를 대화 목록 오류 줄로 넣지 않고 오류 글로 돌려준다 — 카드가 자기 안에 보인다(스펙 2026-10-23-005 디자인 D5).
   *  돌려주는 값: 성공 null, 실패 오류 글. */
  private async act(url: string, body: Record<string, unknown>, quiet = false, sessionId: string | null = this.currentId): Promise<string | null> {
    const S0 = sessionId ? this.sessions[sessionId] ?? null : null;
    if (this.blocked(S0)) return null; // 끊긴 대화 아이디로 보내지 않는다(DR5)
    try {
      await post(url, { session_id: sessionId, ...(S0?.pod ? { pod: S0.pod } : {}), ...body });
      return null;
    } catch (e) {
      const msg = (e as Error).message;
      if (quiet) return msg;
      const S = this.current();
      if (S) S.items.push({ kind: 'error', text: msg, t: Date.now() });
      else this.notice = msg;
      this.notify();
      return msg;
    }
  }
  /** 답을 멈춘다. sessionId 를 주면 목록에서 고른 그 세션을 */
  interrupt(sessionId: string | null = this.currentId) {
    return this.act('/api/chat/interrupt', {}, false, sessionId);
  }

  // ---- 「/」 명령(스펙 2026-10-26-010) ----
  /** 명령 하나를 실행한다. 세션이 없으면 보내기처럼 먼저 만든다(SC4). 돌려주는 값은 입력창 처리(applyCommand) */
  async command(name: string, arg: string): Promise<'clear' | 'keep' | 'prefill'> {
    if (this.blocked(this.current())) return 'keep';
    let S = this.current();
    if (!S || S.closed) {
      S = await this.startSession();
      if (!S) return 'keep';
    }
    const typed = `/${name}${arg ? ` ${arg}` : ''}`;
    let reply: CommandReply;
    try {
      reply = await post<CommandReply>('/api/chat/command', { session_id: S.id, command: name, arg, ...(S.pod ? { pod: S.pod } : {}) });
    } catch (e) {
      reply = { ok: false, error: { code: 'failed', text: t('chat.cmd.failed', { error: (e as Error).message }) } };
    }
    const r = applyCommand(S, typed, reply);
    if (r.input === 'prefill') this.draft = r.draft ?? '';
    this.notify();
    return r.input;
  }
  queueOp(op: 'cancel' | 'drop' | 'send', id?: string) {
    return this.act('/api/chat/queue', { op, ...(id ? { id } : {}) });
  }
  /** 호박색 줄(사라진 예약·다시 답하기 실패)을 닫는다 */
  dismissCommandRow(which: 'queueLost' | 'retryFailed' | 'compressSlow') {
    const S = this.current();
    if (!S) return;
    if (which === 'queueLost') S.queueLost = 0;
    else S[which] = false;
    this.notify();
  }
  approve(choice: string, requestId: string) {
    return this.act('/api/chat/approval', { choice, request_id: requestId }, true);
  }
  clarify(requestId: string, questionId: string | null | undefined, answer: string | string[]) {
    return this.act('/api/chat/clarify', { request_id: requestId, question_id: questionId, answer }, true);
  }
}

/** /api/chat/command 의 답(스펙 2026-10-26-010). 서버 aas/hermes/chat_commands.run 과 같은 모양 */
export type CommandResult =
  | { kind: 'output'; command: string; text: string; background?: boolean }
  | { kind: 'sent'; retry?: boolean }
  | { kind: 'steered' }
  | { kind: 'queued'; count: number }
  | { kind: 'prefill'; text: string }
  | { kind: 'retry_failed'; text: string }
  | { kind: 'compress_timeout' }
  | { kind: 'btw_pending'; count: number };
export type CommandReply = { ok: true; result: CommandResult } | { ok: false; error: { code: string; text: string } };
/** 입력창 위 잠깐 보이는 줄(steer 확인·바쁨 안내)의 시간 */
export const FLASH_MS = 4000;

/** 명령 답을 대화에 반영한다(순수, 시험용). 돌려주는 값: 입력창 처리 — clear 비움, keep 그대로, prefill draft 로 채움 */
export function applyCommand(S: Session, typed: string, reply: CommandReply): { input: 'clear' | 'keep' | 'prefill'; draft?: string } {
  const now = Date.now();
  if (!reply.ok) {
    const { code, text } = reply.error;
    // 거절의 모양(11-4): 사용법·턴 없음은 회색 결과 카드, 바쁨은 입력창 위 회색 줄, 그 밖(이름 겹침·목록 실패·못 씀)은 호박색 안내 줄
    if (code === 'usage' || code === 'empty') {
      S.items.push({ kind: 'command', command: typed.split(/\s/)[0], text, t: now });
      return { input: code === 'usage' ? 'keep' : 'clear' };
    }
    if (code === 'busy') {
      S.flash = { text, until: now + FLASH_MS };
      return { input: 'keep' };
    }
    S.items.push({ kind: 'notice', code: 'command', text, t: now });
    return { input: 'keep' };
  }
  const out = reply.result;
  if (out.kind === 'output') S.items.push({ kind: 'command', command: out.command, text: out.text, t: now, ...(out.background ? { background: true } : {}) });
  else if (out.kind === 'steered') S.flash = { text: t('chat.cmd.steered'), until: now + FLASH_MS };
  else if (out.kind === 'prefill') return { input: 'prefill', draft: out.text };
  else if (out.kind === 'retry_failed') {
    S.retryFailed = true;
    return { input: 'prefill', draft: out.text };
  }
  // sent·queued·compress_timeout 은 서버 이벤트(aas.user·aas.queue·aas.compress)가 그린다
  return { input: 'clear' };
}

export const chatStore = new ChatStore();

/** 저장소가 바뀔 때마다 다시 그리게 한다. 돌려주는 값은 저장소 자체다. */
export function useChat(store: ChatStore = chatStore): ChatStore {
  useSyncExternalStore(store.subscribe, store.getVersion);
  return store;
}

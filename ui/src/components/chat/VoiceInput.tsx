/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력칸의 「말로 입력」(스펙 2026-10-22-005 §3-10·§3-10-1, 구조 D2): 마이크 단추·녹음 띠·안내 줄과 녹음기 하나를 이 파일에 둔다.
// 녹음은 브라우저 MediaRecorder 로 하고, 소리는 AAS 서버(/api/chat/transcribe) → Hermes → Whisper 로 글이 된다.
// 받은 글은 녹음을 시작한 입력칸의 커서 자리에 넣기만 한다(D8) — 넣기는 Composer 가 하고 여기서는 넣을 글만 건넨다.
//
// 녹음기는 화면 전체에 하나다(§10 20A). 모듈 상태로 두고, 다른 입력칸의 마이크는 「다른 창에서 녹음 중입니다」로 막는다.
// 녹음이 끝나는 모든 길(끝내기·취소·오류·버림)에서 마이크 트랙을 곧바로 stop() 한다 — 탭의 녹음 표시가 남지 않게(21A).
import CheckRoundedIcon from '@mui/icons-material/CheckRounded';
import CloseRoundedIcon from '@mui/icons-material/CloseRounded';
import MicNoneOutlinedIcon from '@mui/icons-material/MicNoneOutlined';
import { Box, Button, CircularProgress, IconButton, Tooltip, useMediaQuery } from '@mui/material';
import { useQuery } from '@tanstack/react-query';
import { RefObject, useEffect, useMemo, useRef, useSyncExternalStore } from 'react';

import { tier1 } from '@/components/tierButton';
import { t } from '@/i18n';
import { ApiError, get, post } from '@/lib/api';
import { chatMetrics, chatType } from '@/lib/chatTokens';
import { useMe } from '@/lib/data';

import { readAloud, TtsVoice } from './readAloudPlayer';
import { useChatTokens } from './useChatTokens';

/** Composer 의 voice 값. 세 화면은 이 값만 넘긴다(D2) */
export interface VoiceTarget {
  /** 받아쓸 에이전트. 없으면 지금 에이전트 */
  pod?: string;
  /** 받아쓸 프로파일(주 프로파일은 /api/chat/status 의 primary, §11 E5) */
  profile: string;
  /** 지금 대화. 프로파일이 같아도 이 값이 바뀌면(새 대화·지난 대화 열기) 녹음을 버린다(21A) */
  conversation?: string;
  /** /api/chat/status 의 stt. 값이 오기 전(undefined)에는 단추를 그리지 않는다(R2·23A) */
  stt?: boolean;
  /** 값이 있으면 단추를 aria-disabled 로 막고 이 이유를 툴팁으로 보인다(11A) */
  blockedReason?: string;
  /** 연결 상태를 다시 읽는다 — 마이크·다시 시도·막힌 마이크를 누를 때(§11 M3) */
  refresh?: () => void;
  /** /api/chat/status 의 tts·tts_voices(답 「읽어 주기」, 스펙 2026-10-28-012). 오피스 대화·회의실이 같은 내 에이전트로 읽는다 */
  tts?: boolean;
  ttsVoices?: TtsVoice[];
}

export const VOICE_MAX_MS = 60000;
const WARN_MS = 50000;
const SILENCE_MS = 3000;
const SHORT_MSG_MS = 4000;
const HINT_TIMES = 3;
const HINT_KEY = 'aas-voice-hint-count';
const TICK_MS = 100;
/** 이보다 큰 RMS 면 소리가 들린 것으로 본다(무음 경고, 6A) */
const HEARD_RMS = 0.02;
const MIMES = ['audio/webm;codecs=opus', 'audio/mp4'];
/** [다시 시도]를 보일 HTTP 상태. 그 밖의 오류 응답은 녹음을 버린다(§3-10-1 3A) */
const RETRY_STATUS = [429, 503, 504];

/** 녹음 형식(22A): webm/opus → mp4. 둘 다 안 되면 null(단추를 숨긴다) */
export function pickMime(): string | null {
  const MR = (globalThis as { MediaRecorder?: { isTypeSupported?: (m: string) => boolean } }).MediaRecorder;
  if (!MR) return null;
  return MIMES.find((m) => MR.isTypeSupported?.(m)) ?? null;
}

/** 이 브라우저에서 녹음할 수 있는가: 보안 연결(https·localhost) + getUserMedia + MediaRecorder 형식(§3-10) */
export function voiceSupported(): boolean {
  if (typeof window === 'undefined') return false;
  const local = ['localhost', '127.0.0.1', '::1', '[::1]'].includes(window.location.hostname);
  return (
    (window.isSecureContext === true || local) &&
    typeof navigator.mediaDevices?.getUserMedia === 'function' &&
    !!pickMime()
  );
}

type Phase = 'idle' | 'asking' | 'recording' | 'transcribing' | 'failed';
interface Msg {
  text: string;
  tone: 'muted' | 'warn';
  /** 할 일이 있는 안내(권한·오류·실패)는 띠 아래 한 줄을 더 써서 끝까지 보인다(R14) */
  long: boolean;
}
export interface VoiceSnap {
  /** 녹음을 시작한 입력칸. 없으면 '' */
  owner: string;
  phase: Phase;
  elapsed: number;
  /** 입력 음량 0~1(녹음 점 불투명도, 6A) */
  level: number;
  msg: Msg | null;
  /** 화면 읽기 알림(시작·끝·결과·50초 예고, 18A). n 이 바뀌면 같은 글도 다시 읽는다 */
  announce: { n: number; text: string };
}

type Insert = (text: string) => void;
const ACTIVE: Phase[] = ['asking', 'recording', 'transcribing'];

function readHintCount(): number {
  try {
    return Number(localStorage.getItem(HINT_KEY) || 0) || 0;
  } catch {
    return HINT_TIMES; // 읽지 못하면 더 보이지 않는다(8A, 실패는 무시)
  }
}
function writeHintCount(n: number) {
  try {
    localStorage.setItem(HINT_KEY, String(n));
  } catch {
    // 쓰기 실패는 무시한다(8A)
  }
}

function toDataUrl(blob: Blob): Promise<string> {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(String(r.result));
    r.onerror = () => reject(r.error ?? new Error('read'));
    r.readAsDataURL(blob);
  });
}

function micErrorText(e: unknown): string {
  const name = (e as { name?: string } | null)?.name ?? '';
  if (name === 'NotAllowedError' || name === 'SecurityError') return t('voice.denied');
  if (name === 'NotFoundError' || name === 'OverconstrainedError') return t('voice.notFound');
  if (name === 'NotReadableError' || name === 'AbortError') return t('voice.inUse');
  return t('voice.micError');
}

/** 화면 전체에 하나뿐인 녹음기(20A). React 밖에 두고 useSyncExternalStore 로 본다 */
export class VoiceRecorder {
  snap: VoiceSnap = { owner: '', phase: 'idle', elapsed: 0, level: 0, msg: null, announce: { n: 0, text: '' } };
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private chunks: Blob[] = [];
  /** 마지막 녹음 — 받아쓰기가 실패하면 다시 시도에 쓴다(3A). 서버에는 저장하지 않는다 */
  private blob: Blob | null = null;
  private mime = '';
  private abort: AbortController | null = null;
  /** 버리기·새 녹음마다 올린다. 늦게 끝난 비동기 일은 이 값이 다르면 아무것도 하지 않는다 */
  private token = 0;
  private target: { pod?: string; profile: string } | null = null;
  private insert: Insert | null = null;
  private startedAt = 0;
  /** 녹음 길이(초). 서버 사용 기록에 남긴다 — 소리와 글은 남기지 않는다(§3-9) */
  private seconds = 0;
  private heard = false;
  /** 이번 녹음에서 음량을 쟀다. 못 쟀으면 heard 를 서버에 보내지 않는다 — 서버가 무음 환각을 거르는 근거라 모르면 보내지 않는다(§8-12) */
  private metered = false;
  private warned = false;
  private autoStopped = false;
  /** 녹음 중 연결이 끊겨 끝냈다 — 받아쓰지 않고 녹음을 들고 있는다(3A) */
  private hold = false;

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnap = () => this.snap;
  private set(p: Partial<VoiceSnap>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((f) => f());
  }
  private say(text: string) {
    this.set({ announce: { n: this.snap.announce.n + 1, text } });
  }
  private showMsg(msg: Msg | null, ms = 0) {
    if (this.msgTimer) clearTimeout(this.msgTimer);
    this.msgTimer = null;
    this.set({ msg });
    if (msg && ms) {
      this.msgTimer = setTimeout(() => {
        this.msgTimer = null;
        if (this.snap.msg === msg) this.set({ msg: null });
      }, ms);
    }
  }

  active(): boolean {
    return ACTIVE.includes(this.snap.phase);
  }
  /** 이 입력칸이 녹음·받아쓰기 중인가(보내기를 막는다, 16A·E3) */
  busy(owner: string): boolean {
    return this.snap.owner === owner && this.active();
  }

  /** 마이크를 눌렀다. 첫 await 전에 AudioContext 를 만든다 — Safari 가 정지 상태로 만들어 무음 경고가 거짓으로 뜨지 않게(§11 M5) */
  async start(owner: string, target: { pod?: string; profile: string }, insert: Insert): Promise<void> {
    if (this.active()) return;
    readAloud.stop(); // 녹음이 이긴다: 녹음을 시작하면 읽기를 곧바로 멈춘다(스펙 2026-10-28-012 DD9)
    this.reset();
    const tok = this.token;
    this.target = target;
    this.insert = insert;
    try {
      const AC =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = AC ? new AC() : null;
      void this.ctx?.resume?.()?.catch?.(() => undefined);
    } catch {
      this.ctx = null; // 음량 표시만 빠진다
    }
    this.set({ owner, phase: 'asking', elapsed: 0, level: 0 });
    this.showMsg({ text: t('voice.asking'), tone: 'warn', long: true });
    let stream: MediaStream;
    try {
      stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    } catch (e) {
      if (tok !== this.token) return;
      this.closeMedia();
      this.set({ phase: 'idle' });
      this.showMsg({ text: micErrorText(e), tone: 'warn', long: true });
      return;
    }
    if (tok !== this.token) {
      stream.getTracks().forEach((tr) => tr.stop());
      return;
    }
    this.stream = stream;
    const mime = pickMime() ?? '';
    this.mime = mime.split(';')[0] || 'audio/webm';
    let rec: MediaRecorder;
    try {
      rec = new MediaRecorder(stream, { mimeType: mime, audioBitsPerSecond: 32000 }); // 브라우저마다 크기가 달라지지 않게(§3-10)
    } catch {
      this.closeMedia();
      this.set({ phase: 'idle' });
      this.showMsg({ text: t('voice.micError'), tone: 'warn', long: true });
      return;
    }
    this.rec = rec;
    this.chunks = [];
    rec.ondataavailable = (e: BlobEvent) => {
      if (e.data && e.data.size) this.chunks.push(e.data);
    };
    rec.onstop = () => this.stopped(tok);
    try {
      if (this.ctx) {
        const an = this.ctx.createAnalyser();
        an.fftSize = 512;
        this.ctx.createMediaStreamSource(stream).connect(an);
        this.analyser = an;
        this.metered = true;
      }
    } catch {
      this.analyser = null;
    }
    try {
      rec.start();
    } catch (e) {
      // 처리하지 않으면 start() 의 거절이 되고 마이크·AudioContext 가 열린 채 남는다
      this.closeMedia();
      this.set({ phase: 'idle' });
      this.showMsg({ text: micErrorText(e), tone: 'warn', long: true });
      return;
    }
    this.startedAt = Date.now(); // 타이머는 getUserMedia 가 성공한 뒤부터 센다(5A)
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.set({ phase: 'recording', elapsed: 0 });
    this.showMsg(null);
    this.say(t('voice.started'));
  }

  private tick() {
    if (this.snap.phase !== 'recording') return;
    const elapsed = Math.min(Date.now() - this.startedAt, VOICE_MAX_MS);
    let level = this.snap.level;
    if (this.analyser) {
      const buf = new Uint8Array(this.analyser.fftSize);
      this.analyser.getByteTimeDomainData(buf);
      let sum = 0;
      for (const v of buf) sum += ((v - 128) / 128) ** 2;
      const rms = Math.sqrt(sum / buf.length);
      level = Math.min(1, rms * 5);
      if (rms > HEARD_RMS && !this.heard) {
        this.heard = true;
        if (this.snap.msg?.text === t('voice.silent')) this.showMsg(null);
      }
    }
    if (!this.heard && elapsed >= SILENCE_MS && !this.snap.msg)
      this.showMsg({ text: t('voice.silent'), tone: 'warn', long: true });
    if (elapsed >= WARN_MS && !this.warned) {
      this.warned = true;
      this.say(t('voice.tenLeft')); // 50초 예고는 한 번(7A)
    }
    if (
      Math.round(level * 20) !== Math.round(this.snap.level * 20) ||
      Math.floor(elapsed / 1000) !== Math.floor(this.snap.elapsed / 1000)
    )
      this.set({ elapsed, level });
    if (elapsed >= VOICE_MAX_MS) {
      this.autoStopped = true;
      this.finish(this.snap.owner);
    }
  }

  /** ✓ 끝내기(마이크를 다시 눌러도 같다). 녹음을 끝내고 받아쓰기로 넘어간다 */
  finish(owner: string) {
    if (this.snap.owner !== owner) return;
    if (this.snap.phase === 'asking') return this.cancel(owner);
    if (this.snap.phase !== 'recording' || !this.rec) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.rec.stop(); // onstop → stopped()
    } catch {
      this.stopped(this.token);
    }
  }

  private stopped(tok: number) {
    if (tok !== this.token) return;
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    this.seconds = Math.min(VOICE_MAX_MS / 1000, Math.max(1, Math.round((Date.now() - this.startedAt) / 1000)));
    this.closeMedia();
    this.blob = blob;
    if (this.hold) {
      this.hold = false;
      this.set({ phase: 'failed' });
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
      return;
    }
    this.say(t('voice.stopped'));
    void this.transcribe();
  }

  private async transcribe() {
    const blob = this.blob;
    const target = this.target;
    if (!blob || !target) return;
    const tok = this.token;
    const ac = new AbortController();
    this.abort = ac;
    this.set({ phase: 'transcribing' });
    this.showMsg(this.autoStopped ? { text: t('voice.autoStopped'), tone: 'muted', long: false } : null);
    this.autoStopped = false;
    try {
      const data_url = await toDataUrl(blob);
      if (tok !== this.token) return;
      const r = await post<{ transcript?: string }>(
        '/api/chat/transcribe',
        {
          ...(target.pod ? { pod: target.pod } : {}),
          profile: target.profile,
          mime_type: blob.type || this.mime,
          data_url,
          seconds: this.seconds,
          // 소리가 없었는데 Whisper 가 「감사합니다」 같은 말을 지어내면 서버가 버린다(2026-10-23 무음 환각)
          ...(this.metered ? { heard: this.heard } : {}),
        },
        { signal: ac.signal }
      );
      if (tok !== this.token) return;
      this.abort = null;
      this.blob = null;
      const text = (r.transcript ?? '').trim();
      this.set({ phase: 'idle' });
      if (!text) {
        this.showMsg({ text: t('voice.empty'), tone: 'muted', long: false }, SHORT_MSG_MS); // 빈 글은 회색 4초(4A)
        return;
      }
      this.insert?.(text);
      const shown = readHintCount();
      if (shown < HINT_TIMES) {
        writeHintCount(shown + 1);
        this.showMsg({ text: t('voice.hint'), tone: 'muted', long: false }, SHORT_MSG_MS); // 처음 3번만(8A)
      } else this.showMsg(null);
      this.say(t('voice.inserted')); // 화면 읽기 알림은 늘 한다(8A)
    } catch (e) {
      if (tok !== this.token) return; // 취소·버림
      this.abort = null;
      const api = e instanceof ApiError ? e : null;
      // 다시 해서 나아질 수 있는 것(429·503·504·네트워크)만 [다시 시도]. 400·403·413·502 등은 다시 해도 같다 — 녹음을 버린다
      const retry = !api || RETRY_STATUS.includes(api.status);
      // 서버 문구는 본문의 error 만 쓴다(본문이 없는 프록시 응답의 statusText 는 보이지 않는다). 413 은 앞단(ASGI)이 「too large」로 답하므로 우리 문구로
      const said = typeof api?.data.error === 'string' ? api.data.error.trim() : '';
      const text =
        api?.status === 413
          ? t('voice.tooLong')
          : said || (api?.status === 429 ? t('voice.busy') : retry ? t('voice.failed') : t('voice.failedFinal'));
      if (!retry) {
        this.blob = null;
        this.set({ phase: 'idle' });
        this.showMsg({ text, tone: 'warn', long: true });
        return;
      }
      this.set({ phase: 'failed' }); // 녹음은 메모리에 두고 다시 시도(3A). 실패는 호박색으로 다음 동작까지(4A)
      this.showMsg({ text, tone: 'warn', long: true });
    }
  }

  /** [다시 시도]: 같은 녹음을 다시 보낸다. 연결이 끊겨 있으면 그 안내만(3A) */
  retry(owner: string, blocked: boolean) {
    if (this.snap.owner !== owner || this.snap.phase !== 'failed' || !this.blob) return;
    if (blocked) {
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
      return;
    }
    void this.transcribe();
  }

  /** 녹음·받아쓰는 중 연결이 끊겼다: 녹음을 들고 「연결되면 다시 시도」(3A) */
  holdForConnection(owner: string) {
    if (this.snap.owner !== owner) return;
    if (this.snap.phase === 'recording') {
      this.hold = true;
      this.finish(owner);
    } else if (this.snap.phase === 'transcribing') {
      this.token++;
      this.abort?.abort();
      this.abort = null;
      this.set({ phase: 'failed' });
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
    } else if (this.snap.phase === 'asking') this.discard(owner);
  }

  /** ✕ 취소·Esc: 녹음은 버리고 받아쓰기는 요청을 중단한다(2A·14A) */
  cancel(owner: string) {
    if (this.snap.owner !== owner) return;
    const was = this.snap.phase;
    this.reset();
    this.set({ owner, phase: 'idle' });
    if (was !== 'idle') this.say(t('voice.discarded'));
  }

  /** 대화를 바꾸거나 창을 닫거나 화면을 옮겼다: 조용히 버린다(21A, 문구를 남기지 않는다) */
  discard(owner: string) {
    if (this.snap.owner !== owner) return;
    this.reset();
    this.set({ owner: '', phase: 'idle', elapsed: 0, level: 0 });
  }

  /** 녹음·받아쓰는 동안 보내기를 눌렀다(16A) */
  sendBlocked(owner: string) {
    if (this.busy(owner)) this.showMsg({ text: t('voice.sendBlocked'), tone: 'muted', long: true }, SHORT_MSG_MS);
  }

  private reset() {
    this.token++;
    this.abort?.abort();
    this.abort = null;
    if (this.rec && this.rec.state !== 'inactive') {
      try {
        this.rec.stop();
      } catch {
        // 이미 멈췄다
      }
    }
    this.closeMedia();
    this.blob = null;
    this.chunks = [];
    this.hold = false;
    this.autoStopped = false;
    this.heard = false;
    this.metered = false;
    this.warned = false;
    this.showMsg(null);
  }

  private closeMedia() {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stream?.getTracks().forEach((tr) => tr.stop());
    this.stream = null;
    this.rec = null;
    this.analyser = null;
    if (this.ctx) {
      void this.ctx.close?.()?.catch?.(() => undefined);
      this.ctx = null;
    }
  }
}

export const voiceRecorder = new VoiceRecorder();

/** 시험용: 녹음기를 처음 상태로 */
export function resetVoice() {
  voiceRecorder.discard(voiceRecorder.snap.owner);
  voiceRecorder.snap = { owner: '', phase: 'idle', elapsed: 0, level: 0, msg: null, announce: { n: 0, text: '' } };
}

const useSnap = () => useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnap);

/** Composer 가 보는 이 입력칸의 녹음 상태. 원시 값만 돌려 녹음 중 매 틱마다 Composer 가 다시 그려지지 않게 한다 */
export function useVoiceView(owner: string): { busy: boolean; band: boolean; line: boolean } {
  const key = useSyncExternalStore(voiceRecorder.subscribe, () => {
    const s = voiceRecorder.snap;
    if (s.owner !== owner) return '000';
    const busy = ACTIVE.includes(s.phase);
    const band = busy || s.phase === 'failed' || (!!s.msg && !s.msg.long);
    const line = !!s.msg?.long;
    return `${+busy}${+band}${+line}`;
  });
  return { busy: key[0] === '1', band: key[1] === '1', line: key[2] === '1' };
}

const clock = (ms: number) => {
  const s = Math.floor(ms / 1000);
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;
};

/** 띠 안 단추의 손가락 터치 영역 44px(19A) */
const touch = { '@media (pointer: coarse)': { minWidth: chatMetrics.touch, minHeight: chatMetrics.touch } };
const keepFocus = (e: React.PointerEvent) => e.preventDefault(); // 입력칸 포커스를 뺏지 않는다(17A)

/** 마이크 단추. 입력칸 아래 줄의 [첨부] 다음 자리(1A). Esc 가로채기·대화 바꾸기 때 버리기·연결 끊김 처리도 여기서 한다 */
export function VoiceButton({
  owner,
  voice,
  onInsert,
  suggestOpen,
  rootRef,
}: {
  owner: string;
  voice: VoiceTarget;
  onInsert: Insert;
  /** 「/」·「@」 고르기 목록이 열려 있으면 Esc 는 목록이 먼저다(E2) */
  suggestOpen: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const tk = useChatTokens();
  const s = useSnap();
  const supported = useMemo(voiceSupported, []);
  const insertRef = useRef(onInsert);
  insertRef.current = onInsert;
  const openRef = useRef(suggestOpen);
  openRef.current = suggestOpen;
  const mine = s.owner === owner;
  const mineActive = mine && ACTIVE.includes(s.phase);
  const other = !mine && ACTIVE.includes(s.phase);
  const blocked = !!voice.blockedReason;

  // 대화를 바꾸거나(대상·같은 프로파일의 대화가 바뀜) 창을 닫거나 화면을 옮기면(언마운트) 버린다(21A)
  useEffect(() => () => voiceRecorder.discard(owner), [owner, voice.pod, voice.profile, voice.conversation]);
  // 녹음·받아쓰는 도중 연결이 끊기면 녹음을 들고 다시 시도를 기다린다(3A)
  useEffect(() => {
    if (blocked) voiceRecorder.holdForConnection(owner);
  }, [blocked, owner]);
  // Esc: 녹음·받아쓰는 동안만 capture 로 먼저 받아 녹음만 버린다(14A). 조합 중·고르기 목록·다른 대화상자·팔레트가 열려 있으면 그쪽이 먼저(E2·M6)
  useEffect(() => {
    if (!mineActive) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key !== 'Escape' || e.isComposing || openRef.current) return;
      const root = rootRef.current;
      const modal = Array.from(document.querySelectorAll('.MuiModal-root, [role="dialog"][aria-modal="true"]')).some(
        (el) => !el.classList.contains('MuiModal-hidden') && !(root && el.contains(root))
      );
      if (modal) return;
      e.preventDefault();
      e.stopPropagation();
      voiceRecorder.cancel(owner);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [mineActive, owner, rootRef]);

  if (voice.stt !== true || !supported) return null; // stt 값이 온 뒤 한 번에 그린다(23A), 브라우저 조건(§3-10)

  const reason = other ? t('voice.otherWindow') : !mineActive && blocked ? voice.blockedReason : '';
  const label =
    mine && s.phase === 'recording'
      ? t('voice.finishLabel')
      : mine && s.phase === 'transcribing'
      ? t('voice.cancelTranscribe')
      : t('voice.label');
  const press = () => {
    if (reason) {
      voice.refresh?.(); // 막힌 마이크를 누르면 연결 상태를 다시 읽는다(M3)
      return;
    }
    if (mine && s.phase === 'recording') return voiceRecorder.finish(owner);
    if (mine && (s.phase === 'transcribing' || s.phase === 'asking')) return voiceRecorder.cancel(owner);
    void voiceRecorder.start(owner, { pod: voice.pod, profile: voice.profile }, (text) => insertRef.current(text));
    voice.refresh?.(); // 누를 때 연결 상태를 다시 읽는다(M3). start 가 AudioContext 를 먼저 만든 뒤다(M5)
  };
  return (
    <Tooltip title={reason || t('voice.tooltip')}>
      <IconButton
        aria-label={label}
        data-guide="chat.voice"
        aria-disabled={reason ? true : undefined}
        size="small"
        onPointerDown={keepFocus}
        onClick={press}
        sx={{ color: tk.muted, ...(reason ? { opacity: 0.45, cursor: 'default' } : {}) }}
      >
        <MicNoneOutlinedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
}

/** 녹음 띠: 녹음·받아쓰는 동안 아래 줄 가운데(키 안내·안내 글·AI 경고)를 대신한다(1A). `● 0:12 / 1:00  [✕] [✓]` */
export function VoiceBand({
  owner,
  id,
  blocked,
  refresh,
}: {
  owner: string;
  id: string;
  blocked: boolean;
  refresh?: () => void;
}) {
  const tk = useChatTokens();
  const s = useSnap();
  const reduced = useMediaQuery('(prefers-reduced-motion: reduce)');
  if (s.owner !== owner) return null;
  const color = (m: Msg | null) => (m?.tone === 'warn' ? tk.warn : tk.muted);
  const text = {
    fontSize: chatType.meta,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    minWidth: 0,
  } as const;
  const cancelBtn = (label: string) => (
    <Tooltip title={label}>
      <IconButton
        aria-label={label}
        size="small"
        onPointerDown={keepFocus}
        onClick={() => voiceRecorder.cancel(owner)}
        sx={{ color: tk.muted, ...touch }}
      >
        <CloseRoundedIcon fontSize="small" />
      </IconButton>
    </Tooltip>
  );
  let body: React.ReactNode = null;
  if (s.phase === 'asking' || s.phase === 'recording') {
    const late = s.elapsed >= WARN_MS;
    body = (
      <>
        <Box
          aria-hidden
          sx={{
            width: 8,
            height: 8,
            borderRadius: '50%',
            bgcolor: '#ef5350', // 마이크가 켜져 있다는 주의 신호 — DESIGN.md §1-3.1 의 예외(13A)
            flex: '0 0 auto',
            opacity: s.phase === 'asking' ? 0.35 : reduced ? 1 : 0.35 + 0.65 * s.level, // 장식 깜박임 없이 음량만 따른다(6A)
          }}
        />
        <Box aria-hidden sx={{ ...text, color: late ? tk.warn : tk.muted, fontVariantNumeric: 'tabular-nums' }}>
          {`${clock(s.elapsed)} / ${clock(VOICE_MAX_MS)}`}
        </Box>
        <Box sx={{ flex: 1 }} />
        {cancelBtn(t('voice.cancelRecording'))}
        <Tooltip title={t('voice.finishLabel')}>
          <Button
            variant="outlined"
            color="inherit"
            aria-label={t('voice.finishLabel')}
            aria-disabled={s.phase === 'asking' ? true : undefined}
            onPointerDown={keepFocus}
            onClick={() => voiceRecorder.finish(owner)}
            sx={[tier1 as object, { minWidth: 0, width: 32, height: 32, p: 0, borderRadius: '8px' }, touch]}
          >
            <CheckRoundedIcon fontSize="small" />
          </Button>
        </Tooltip>
      </>
    );
  } else if (s.phase === 'transcribing') {
    body = (
      <>
        <CircularProgress size={12} thickness={5} sx={{ color: tk.muted, flex: '0 0 auto' }} aria-hidden />
        {/* 1분에 저절로 끝났으면 그 안내를 받아쓰는 동안 보인다(7A) */}
        <Box role="status" sx={{ ...text, color: tk.muted }}>
          {s.msg && !s.msg.long ? s.msg.text : t('voice.transcribing')}
        </Box>
        <Box sx={{ flex: 1 }} />
        {cancelBtn(t('voice.cancelTranscribe'))}
      </>
    );
  } else if (s.phase === 'failed') {
    body = (
      <>
        <Box sx={{ ...text, color: tk.warn }}>{t('voice.failedShort')}</Box>
        <Box sx={{ flex: 1 }} />
        <Button
          size="small"
          color="inherit"
          onPointerDown={keepFocus}
          onClick={() => {
            refresh?.(); // 다시 시도를 누를 때 연결 상태를 다시 읽는다(M3)
            voiceRecorder.retry(owner, blocked);
          }}
          sx={{ color: tk.text, fontSize: chatType.meta, minWidth: 0, px: 1, ...touch }}
        >
          {t('voice.retry')}
        </Button>
        {cancelBtn(t('voice.dismiss'))}
      </>
    );
  } else if (s.msg && !s.msg.long) {
    body = (
      <Box role="status" sx={{ ...text, color: color(s.msg) }}>
        {s.msg.text}
      </Box>
    );
  }
  if (!body) return null;
  // 짧은 상태 문구는 띠 자리에 role=status 로(4A). 할 일이 있는 긴 안내는 VoiceLine 이 띠 아래에 보인다(R14)
  return (
    <Box id={id} sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
      {body}
    </Box>
  );
}

/** 할 일이 있는 안내(권한·마이크 오류·받아쓰기 실패)는 띠 아래 한 줄을 더 써서 끝까지 보인다(R14). 화면 읽기 알림 영역도 여기 둔다(18A) */
export function VoiceLine({ owner, id }: { owner: string; id: string }) {
  const tk = useChatTokens();
  const s = useSnap();
  const mine = s.owner === owner;
  const msg = mine && s.msg?.long ? s.msg : null;
  return (
    <>
      {msg && (
        <Box
          id={id}
          role="status"
          sx={{
            px: 1.5,
            pb: 1,
            mt: -0.5,
            fontSize: chatType.meta,
            lineHeight: 1.5,
            color: msg.tone === 'warn' ? tk.warn : tk.muted,
            whiteSpace: 'normal',
            overflowWrap: 'anywhere',
          }}
        >
          {msg.text}
        </Box>
      )}
      <Box
        aria-live="polite"
        sx={{
          position: 'absolute',
          width: 1,
          height: 1,
          overflow: 'hidden',
          clip: 'rect(0 0 0 0)',
          whiteSpace: 'nowrap',
        }}
      >
        {mine && s.announce.text ? s.announce.text + (s.announce.n % 2 ? ' ' : '') : ''}
      </Box>
    </>
  );
}

interface VoiceStatus {
  stt?: boolean;
  tts?: boolean;
  tts_voices?: TtsVoice[];
  primary?: string;
  /** 사이드카·대시보드 오류. 있으면 막는다. connected(채팅 웹소켓이 열려 있는가)는 보지 않는다 — 받아쓰기는 HTTP 다 */
  error?: string;
}

/** 오피스 대화·회의실의 받아쓰기 대상: 받는 에이전트와 관계없이 내 에이전트의 주 프로파일(R9·R11·R12).
 *  내 에이전트는 주인 기준 own_pods 에서 고른다 — 지금 고른 에이전트가 내 것이면 그것, 아니면 이름순 첫째(§11 L2). 없으면 undefined(단추 없음).
 *  상태(stt·error)는 열 때 읽고, 마이크·다시 시도·막힌 마이크를 누를 때 다시 읽는다(§11 M3) */
export function useMyVoice(): VoiceTarget | undefined {
  const me = useMe().data;
  const own = useMemo(() => [...(me?.own_pods ?? [])].sort(), [me?.own_pods]);
  const pod = me?.pod && own.includes(me.pod.id) ? me.pod.id : own[0];
  const q = useQuery<VoiceStatus>({
    queryKey: ['voice-status', pod],
    queryFn: () => get<VoiceStatus>(`/api/chat/status?pod=${encodeURIComponent(pod ?? '')}`),
    enabled: !!pod,
    staleTime: 0,
    refetchOnMount: 'always',
  });
  if (!pod) return undefined;
  const d = q.data;
  return {
    pod,
    profile: d?.primary || 'default',
    stt: d ? d.stt === true : undefined,
    // 상태에 error 가 있거나 상태 읽기 자체가 실패하면 막는다. connected:false 는 막지 않는다(채팅 웹소켓은 대화를 보낼 때만 열린다)
    blockedReason: d && (d.error || q.isError) ? t('voice.blockedMine') : undefined,
    refresh: () => void q.refetch(),
    tts: d ? d.tts === true : undefined,
    ttsVoices: d?.tts_voices,
  };
}

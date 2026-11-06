/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 입력칸의 「말로 입력」(스펙 2026-10-22-005 §3-10·§3-10-1, 구조 D2): 마이크 단추·녹음 띠·안내 줄과 녹음기 하나를 이 파일에 둔다.
// 녹음은 브라우저 MediaRecorder 로 하고, 소리는 AAS 서버(/api/chat/transcribe) → Hermes → Whisper 로 글이 된다.
// 스트리밍(OMAI-1554, 계약 stt-stream-protocol.md): /api/chat/status 의 stt_stream 이 참이면 AudioWorklet 의 16kHz PCM 을 웹소켓으로 보내고
// 중간 글은 녹음 띠 안 회색 줄에만, 확정 구간만 입력칸 끝에 덧붙인다(D21·D19). 스트리밍을 못 쓰면 녹음을 이어 가고 끝낸 뒤 일괄로(폴백),
// 도중에 끊기면 마지막 확정 이후의 PCM 을 WAV 로 일괄 경로에 다시 보낸다(D22).
// 2차 인식(스펙 2026-11-01-001 D27): final.pending 이면 「다듬는 중…」(refining, 보내기는 풀림 D14)으로 기다리고, refined 가 오면
// 이번 녹음 글을 손대지 않았을 때만 통째로 바꾼다. 바꾸기·되돌리기는 Composer 가 한다(VoiceEdit).
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
import { PCM_RATE, StreamMsg, streamUrl, sttDeps, wavParts } from './sttStream';
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
  /** /api/chat/status 의 stt_stream·stt_stream_max_seconds(OMAI-1554). 참이면 스트리밍을 먼저 시도한다 */
  sttStream?: boolean;
  sttStreamMaxSeconds?: number;
  /** 값이 있으면 단추를 aria-disabled 로 막고 이 이유를 툴팁으로 보인다(11A) */
  blockedReason?: string;
  /** 연결 상태를 다시 읽는다 — 마이크·다시 시도·막힌 마이크를 누를 때(§11 M3) */
  refresh?: () => void;
  /** /api/chat/status 의 tts·tts_voices(답 「읽어 주기」, 스펙 2026-10-28-012). 오피스 대화·회의실이 같은 내 에이전트로 읽는다 */
  tts?: boolean;
  ttsVoices?: TtsVoice[];
}

export const VOICE_MAX_MS = 60000;
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

/** refining: 스트리밍 글은 다 들어왔고 2차 결과를 기다린다(ACTIVE 가 아니라 보낼 수 있다, D14) */
type Phase = 'idle' | 'asking' | 'recording' | 'transcribing' | 'refining' | 'failed';
interface Msg {
  text: string;
  tone: 'muted' | 'warn';
  /** 할 일이 있는 안내(권한·오류·실패)는 띠 아래 한 줄을 더 써서 끝까지 보인다(R14) */
  long: boolean;
  /** 「되돌리기」 단추를 함께 보인다(2차 인식으로 바꾼 뒤, D19) */
  undo?: boolean;
}
export interface VoiceSnap {
  /** 녹음을 시작한 입력칸. 없으면 '' */
  owner: string;
  phase: Phase;
  elapsed: number;
  /** 이번 녹음의 최대 길이(ms). 일괄은 1분, 스트리밍은 서버 ready 의 max_seconds(OMAI-1554) */
  maxMs: number;
  /** 입력 음량 0~1(녹음 점 불투명도, 6A) */
  level: number;
  msg: Msg | null;
  /** 화면 읽기 알림(시작·끝·결과·50초 예고, 18A). n 이 바뀌면 같은 글도 다시 읽는다 */
  announce: { n: number; text: string };
  /** 스트리밍의 중간 글. 녹음 띠 안 회색 줄에만 보이고 입력칸에는 넣지 않는다(D21) */
  interim: string;
  /** 스트리밍 연결 중(ready 전). 띠에 작은 진행 표시 */
  connecting: boolean;
}

/** 넣을 글. append 면 입력칸 끝에 덧붙이고 사용자의 커서·고친 글은 건드리지 않는다(스트리밍 확정 구간, D19) */
type Insert = (text: string, opts?: { append?: boolean }) => void;
/** 2차 인식(스펙 2026-11-01-001 D27): 이번 녹음 글을 통째로 바꾸고 되돌린다. 입력칸 값은 Composer 가 갖고 있어 거기서 한다 */
export interface VoiceEdit {
  /** 새 녹음을 시작했다 — 이번 녹음 글의 범위를 새로 잡는다 */
  begin: () => void;
  /** 이번 녹음 글을 손대지 않았으면 text 로 바꾼다. 한글 조합 중·방금 손댄 뒤면 1초까지 기다린다(D16). 바꿨으면 true */
  refine: (text: string) => Promise<boolean>;
  /** 바꾼 글을 스트리밍 원문으로 돌린다(D19). 바꾼 뒤 고쳤으면 하지 않는다 */
  undo: () => void;
}
const ACTIVE: Phase[] = ['asking', 'recording', 'transcribing'];
/** 스트리밍 기본 최대 길이(초). 서버 ready 의 max_seconds 가 정한다(계약 §4) */
export const STREAM_MAX_SECONDS = 300;
/** ready 를 이만큼 못 받으면 일괄 경로로 넘어간다 */
const CONNECT_MS = 8000;
/** end 뒤 done 을 이만큼 못 받으면 끊긴 것으로 보고 D22 재전사 */
const FINISH_MS = 15000;
/** 이 시간 안에 이어 온 확정 구간은 한 번에 읽는다(D24) */
const SAY_MERGE_MS = 1500;
const WARN_BEFORE_MS = 10000;
/** 이 오류는 스트리밍만 못 쓰는 것이다 — 녹음을 이어 가고 끝낸 뒤 일괄 경로로 받아쓴다(계약 §2 표) */
const FALLBACK_CODES = ['busy', 'bad_audio', 'disabled'];

const initialSnap = (): VoiceSnap => ({
  owner: '',
  phase: 'idle',
  elapsed: 0,
  maxMs: VOICE_MAX_MS,
  level: 0,
  msg: null,
  announce: { n: 0, text: '' },
  interim: '',
  connecting: false,
});

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

/** 녹음기를 시작할 때 넘기는 대상. stream 이면 스트리밍을 먼저 시도한다(/api/chat/status 의 stt_stream, OMAI-1554) */
export interface RecordTarget {
  pod?: string;
  profile: string;
  stream?: boolean;
  maxSeconds?: number;
}

/** 녹음 방식: batch=MediaRecorder 로 녹음 뒤 일괄(지금까지), stream=PCM 을 웹소켓으로, pcm=스트리밍을 못 써 PCM 을 들고 있다가 일괄로 */
type Mode = 'batch' | 'stream' | 'pcm';

/** 화면 전체에 하나뿐인 녹음기(20A). React 밖에 두고 useSyncExternalStore 로 본다 */
export class VoiceRecorder {
  snap: VoiceSnap = initialSnap();
  private listeners = new Set<() => void>();
  private stream: MediaStream | null = null;
  private rec: MediaRecorder | null = null;
  private ctx: AudioContext | null = null;
  private analyser: AnalyserNode | null = null;
  private timer: ReturnType<typeof setInterval> | null = null;
  private msgTimer: ReturnType<typeof setTimeout> | null = null;
  private chunks: Blob[] = [];
  /** 받아쓸 녹음 조각들 — 받아쓰기가 실패하면 남은 조각으로 다시 시도한다(3A). 서버에는 저장하지 않는다 */
  private parts: { blob: Blob; seconds: number }[] = [];
  private mime = '';
  private abort: AbortController | null = null;
  /** 버리기·새 녹음마다 올린다. 늦게 끝난 비동기 일은 이 값이 다르면 아무것도 하지 않는다 */
  private token = 0;
  private target: RecordTarget | null = null;
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
  // ---- 스트리밍(OMAI-1554) ----
  private mode: Mode = 'batch';
  private ws: WebSocket | null = null;
  private wsReady = false;
  /** ready 전에 잡은 소리. ready 를 받으면 차례대로 보낸다 */
  private sendQueue: ArrayBuffer[] = [];
  /** 마지막 확정 구간 이후의 PCM(D22). 끊기면 이것만 일괄 경로로 다시 받아쓴다. 5분이면 약 9.6MB */
  private pcm: ArrayBuffer[] = [];
  private stopCapture: (() => void) | null = null;
  /** 이번 녹음에서 입력칸에 넣은 확정 구간 수 */
  private segments = 0;
  /** 받아쓴 글을 입력칸 끝에 덧붙인다(스트리밍에서 한 번이라도 넣었으면 이후는 모두) */
  private append = false;
  private connectTimer: ReturnType<typeof setTimeout> | null = null;
  private finishTimer: ReturnType<typeof setTimeout> | null = null;
  private sayTimer: ReturnType<typeof setTimeout> | null = null;
  private pendingSay = '';
  private edit: VoiceEdit | null = null;
  /** 받은 refined 를 입력칸에 넣는 중(보류 포함). done 때 결과를 보고 「다듬었습니다」를 보인다 */
  private refining: Promise<boolean> | null = null;

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
  async start(owner: string, target: RecordTarget, insert: Insert, edit?: VoiceEdit): Promise<void> {
    if (this.active()) return;
    readAloud.stop(); // 녹음이 이긴다: 녹음을 시작하면 읽기를 곧바로 멈춘다(스펙 2026-10-28-012 DD9)
    this.reset();
    const tok = this.token;
    this.target = target;
    this.insert = insert;
    this.edit = edit ?? null;
    edit?.begin();
    try {
      const AC =
        window.AudioContext ?? (window as unknown as { webkitAudioContext?: typeof AudioContext }).webkitAudioContext;
      this.ctx = AC ? new AC() : null;
      void this.ctx?.resume?.()?.catch?.(() => undefined);
    } catch {
      this.ctx = null; // 음량 표시만 빠진다
    }
    const streaming = !!target.stream && sttDeps.supported(this.ctx);
    const maxMs = streaming ? (target.maxSeconds || STREAM_MAX_SECONDS) * 1000 : VOICE_MAX_MS;
    this.set({ owner, phase: 'asking', elapsed: 0, level: 0, maxMs, interim: '', connecting: false });
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
    if (streaming) {
      if (await this.startStream(stream, tok, target)) return;
      if (tok !== this.token) return;
      this.set({ maxMs: VOICE_MAX_MS }); // 소리 잡기를 못 열었다 — 지금까지의 녹음 방식으로
    }
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

  // ---- 스트리밍(OMAI-1554, 계약 stt-stream-protocol.md) ---------------------------------
  /** AudioWorklet 으로 16kHz PCM 을 잡고 웹소켓을 연다. 소리 잡기를 못 열면 false(부른 쪽이 MediaRecorder 로) */
  private async startStream(stream: MediaStream, tok: number, target: RecordTarget): Promise<boolean> {
    let stop: () => void;
    try {
      stop = await sttDeps.capture(this.ctx as AudioContext, stream, (buf) => this.onPcm(tok, buf));
    } catch {
      return false;
    }
    if (tok !== this.token) {
      stop();
      return true;
    }
    this.stopCapture = stop;
    this.mode = 'stream';
    this.startedAt = Date.now();
    this.timer = setInterval(() => this.tick(), TICK_MS);
    this.set({ phase: 'recording', elapsed: 0, connecting: true });
    this.showMsg(null);
    this.say(t('voice.started'));
    this.openSocket(tok, target);
    return true;
  }

  private openSocket(tok: number, target: RecordTarget) {
    let ws: WebSocket;
    try {
      ws = sttDeps.socket(streamUrl(target));
    } catch {
      this.toPcm(tok, '');
      return;
    }
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    this.wsReady = false;
    this.connectTimer = setTimeout(() => {
      if (tok === this.token && this.ws === ws && !this.wsReady) this.toPcm(tok, '');
    }, CONNECT_MS);
    ws.onopen = () => {
      if (tok !== this.token || this.ws !== ws) return;
      ws.send(JSON.stringify({ type: 'start', lang: 'ko', sample_rate: PCM_RATE }));
    };
    ws.onmessage = (e: MessageEvent) => {
      if (tok !== this.token || this.ws !== ws || typeof e.data !== 'string') return;
      let m: StreamMsg;
      try {
        m = JSON.parse(e.data) as StreamMsg;
      } catch {
        return;
      }
      this.onStreamMsg(tok, m);
    };
    // 오류 메시지 없이 닫혔다(서버·프록시가 끊음). 우리가 닫은 연결은 this.ws 가 이미 비어 있어 여기 오지 않는다
    ws.onclose = () => {
      if (tok !== this.token || this.ws !== ws) return;
      this.ws = null;
      if (this.snap.phase === 'refining') this.streamDone(); // 스트리밍 글은 다 들어왔다 — 다듬기만 건너뛴다(D13)
      else if (!this.wsReady) this.toPcm(tok, '');
      else this.recover(tok);
    };
  }

  private closeSocket() {
    const ws = this.ws;
    this.ws = null;
    this.wsReady = false;
    this.sendQueue = [];
    if (this.connectTimer) clearTimeout(this.connectTimer);
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.connectTimer = this.finishTimer = null;
    if (ws) {
      try {
        ws.close(1000);
      } catch {
        // 이미 닫혔다
      }
    }
  }

  private onPcm(tok: number, buf: ArrayBuffer) {
    if (tok !== this.token || this.snap.phase !== 'recording' || this.mode === 'batch') return;
    this.pcm.push(buf);
    if (this.mode !== 'stream') return;
    if (this.wsReady && this.ws) this.ws.send(buf);
    else this.sendQueue.push(buf); // 연결 중에도 녹음한다 — ready 뒤에 보낸다(계약 §2)
  }

  private onStreamMsg(tok: number, m: StreamMsg) {
    if (m.type === 'ready') {
      if (this.connectTimer) clearTimeout(this.connectTimer);
      this.connectTimer = null;
      this.wsReady = true;
      const max = Number(m.max_seconds);
      this.set({ connecting: false, ...(max > 0 ? { maxMs: max * 1000 } : {}) }); // 최대 길이는 서버가 정한다
      const queued = this.sendQueue;
      this.sendQueue = [];
      queued.forEach((b) => this.ws?.send(b));
    } else if (m.type === 'interim') {
      if (this.snap.phase === 'recording') this.set({ interim: String(m.text ?? '') });
    } else if (m.type === 'segment') {
      this.onSegment(String(m.text ?? ''));
    } else if (m.type === 'final') {
      if (!this.segments && m.text) this.onSegment(String(m.text)); // 보통은 segment 로 이미 넣었다(final 은 같은 내용)
      if (Number(m.pending) > 0 && this.snap.phase === 'transcribing' && this.segments) this.toRefining(tok);
    } else if (m.type === 'refined') {
      const text = String(m.text ?? '').trim(); // 앞뒤 공백은 입력칸에 있던 것을 둔다(D21)
      if (this.snap.phase === 'refining' && text && this.edit && !this.refining) this.refining = this.edit.refine(text);
    } else if (m.type === 'done') {
      this.streamDone();
    } else if (m.type === 'error') {
      this.onStreamError(tok, String(m.code ?? ''));
    }
  }

  /** 확정 구간: 입력칸 끝에 덧붙이고 중간 글 줄을 비운다. 그 앞의 PCM 은 더 들고 있지 않는다(D19·D21·D22) */
  private onSegment(raw: string) {
    this.pcm = [];
    this.set({ interim: '' });
    const text = raw.trim();
    if (!text) return;
    this.insert?.(text, { append: true });
    this.segments += 1;
    this.append = true;
    // 화면 읽기는 확정 구간만, 이어 온 것은 합쳐 한 번(D24). 중간 글은 aria-hidden
    this.pendingSay = this.pendingSay ? `${this.pendingSay} ${text}` : text;
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = setTimeout(() => this.flushSay(), SAY_MERGE_MS);
  }

  private flushSay() {
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = null;
    const text = this.pendingSay;
    this.pendingSay = '';
    if (text) this.say(text);
  }

  /** final.pending(D24): 글은 다 들어왔다. 보내기를 풀고 「다듬는 중…」으로 refined·done 을 기다린다(D13·D14) */
  private toRefining(tok: number) {
    this.pcm = []; // 끊겨도 다시 받아쓸 것이 없다 — 다듬기만 건너뛴다
    if (this.finishTimer) clearTimeout(this.finishTimer);
    this.finishTimer = setTimeout(() => {
      if (tok === this.token && this.snap.phase === 'refining') this.streamDone();
    }, FINISH_MS);
    this.flushSay();
    this.set({ phase: 'refining', interim: '' });
    this.showMsg(null);
  }

  private streamDone() {
    const tok = this.token;
    const refining = this.refining;
    this.refining = null;
    this.closeSocket();
    this.mode = 'batch';
    this.flushSay();
    this.set({ phase: 'idle', interim: '', connecting: false });
    if (!this.segments) {
      this.showMsg({ text: t('voice.empty'), tone: 'muted', long: false }, SHORT_MSG_MS);
      return;
    }
    if (!refining) return this.showHint();
    // 보류 중인 refined 는 보류가 끝난 뒤 넣는다(D16). 건너뛰었으면 알리지 않는다(D13). 그 사이 보냈거나 새로 녹음했으면 token 이 바뀐다
    void refining.then((ok) => {
      if (tok !== this.token) return;
      if (!ok) return this.showHint();
      this.showMsg({ text: t('voice.refined'), tone: 'muted', long: false, undo: true }, SHORT_MSG_MS);
      this.say(t('voice.refinedInserted')); // D18: 바꾼 때만 한 번
    });
  }

  /** 보냈다(D14): 다듬는 중이면 남은 2차 결과를 버리고 연결을 닫는다. 다듬은 뒤의 「되돌리기」도 거둔다 */
  sent(owner: string) {
    if (this.snap.owner !== owner) return;
    if (this.snap.phase === 'refining') {
      this.token++; // 보류 중인 refined 의 결과도 버린다
      this.refining = null;
      this.closeSocket();
      this.mode = 'batch';
      if (this.sayTimer) clearTimeout(this.sayTimer);
      this.sayTimer = null;
      this.pendingSay = '';
      this.set({ phase: 'idle', interim: '' });
      this.showMsg(null);
    } else if (this.snap.msg?.undo) this.showMsg(null);
  }

  /** 띠의 「되돌리기」(D19): 문구가 보이는 동안만 */
  undo(owner: string) {
    if (this.snap.owner !== owner || !this.snap.msg?.undo) return;
    this.edit?.undo();
    this.showMsg(null);
  }

  private onStreamError(tok: number, code: string) {
    if (this.snap.phase === 'refining') return this.streamDone(); // 글은 다 들어왔다 — 다듬기만 건너뛴다(D13)
    if (code === 'unauthorized' || code === 'forbidden') {
      this.stopStream();
      this.set({ phase: 'idle' });
      this.showMsg({
        text: t(code === 'unauthorized' ? 'voice.loginRequired' : 'voice.forbidden'),
        tone: 'warn',
        long: true,
      });
      return;
    }
    if (code === 'too_long') {
      // 서버가 남은 구간을 segment 로 먼저 보냈다(계약 §2). 녹음을 끝낸다
      this.stopStream();
      this.flushSay();
      this.set({ phase: 'idle' });
      this.showMsg({ text: t('voice.tooLong'), tone: 'warn', long: true });
      return;
    }
    if (!this.wsReady || FALLBACK_CODES.includes(code)) {
      this.toPcm(tok, code);
      return;
    }
    this.recover(tok); // engine·idle 과 그 밖: 확정 이후의 소리를 일괄 경로로(D22)
  }

  /** 스트리밍을 쓸 수 없다: 녹음은 그대로 잇고 끝낸 뒤 일괄 경로로 받아쓴다(계약 §2 busy·bad_audio·disabled, 연결 실패) */
  private toPcm(tok: number, code: string) {
    if (tok !== this.token) return;
    this.closeSocket();
    if (this.snap.phase !== 'recording') {
      this.recover(tok);
      return;
    }
    this.mode = 'pcm';
    this.set({ connecting: false, interim: '' });
    if (code === 'busy') this.showMsg({ text: t('voice.streamBusy'), tone: 'muted', long: true }, SHORT_MSG_MS);
  }

  /** 소리 잡기·웹소켓·마이크를 모두 닫는다(녹음 조각은 그대로) */
  private stopStream() {
    this.stopCapture?.();
    this.stopCapture = null;
    this.closeSocket();
    this.closeMedia();
    this.mode = 'batch';
    this.set({ interim: '', connecting: false });
  }

  /** 들고 있는 PCM 을 일괄 경로로 보낼 조각으로 바꾼다 */
  private takePcm() {
    this.parts = wavParts(this.pcm);
    this.pcm = [];
    this.mime = 'audio/wav';
  }

  /** D22: 연결이 끊겼다 — 마지막 확정 이후의 PCM 을 일괄 경로로 다시 받아쓴다(「연결이 끊겨 마저 받아쓰는 중」) */
  private recover(tok: number) {
    if (tok !== this.token) return;
    const lost = this.mode === 'stream';
    this.stopStream();
    this.takePcm();
    if (!this.parts.length) {
      this.flushSay();
      this.set({ phase: 'idle' });
      if (!this.segments) this.showMsg({ text: t('voice.empty'), tone: 'muted', long: false }, SHORT_MSG_MS);
      return;
    }
    void this.transcribe(lost ? { text: t('voice.recovering'), tone: 'muted', long: false } : null);
  }

  private tick() {
    if (this.snap.phase !== 'recording') return;
    const max = this.snap.maxMs;
    const elapsed = Math.min(Date.now() - this.startedAt, max);
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
    if (elapsed >= max - WARN_BEFORE_MS && !this.warned) {
      this.warned = true;
      this.say(t('voice.tenLeft')); // 끝나기 10초 전 예고는 한 번(7A)
    }
    if (
      Math.round(level * 20) !== Math.round(this.snap.level * 20) ||
      Math.floor(elapsed / 1000) !== Math.floor(this.snap.elapsed / 1000)
    )
      this.set({ elapsed, level });
    if (elapsed >= max) {
      this.autoStopped = true;
      this.finish(this.snap.owner);
    }
  }

  private autoStoppedMsg(): Msg {
    const text =
      this.snap.maxMs === VOICE_MAX_MS
        ? t('voice.autoStopped')
        : t('voice.autoStoppedAt', { time: clock(this.snap.maxMs) });
    return { text, tone: 'muted', long: false };
  }

  /** ✓ 끝내기(마이크를 다시 눌러도 같다). 녹음을 끝내고 받아쓰기로 넘어간다 */
  finish(owner: string) {
    if (this.snap.owner !== owner) return;
    if (this.snap.phase === 'asking') return this.cancel(owner);
    if (this.snap.phase !== 'recording') return;
    if (this.mode !== 'batch') return this.finishStream();
    if (!this.rec) return;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    try {
      this.rec.stop(); // onstop → stopped()
    } catch {
      this.stopped(this.token);
    }
  }

  /** 스트리밍 끝내기: end 를 보내고 남은 구간이 확정될 때까지 「마무리하는 중」. 아직 ready 전이거나 일괄로 넘어갔으면 PCM 을 일괄로 */
  private finishStream() {
    const tok = this.token;
    this.stopCapture?.();
    this.stopCapture = null;
    this.closeMedia();
    this.say(t('voice.stopped'));
    if (this.mode === 'stream' && this.wsReady && this.ws) {
      this.ws.send(JSON.stringify({ type: 'end' }));
      this.set({ phase: 'transcribing', interim: '' });
      this.showMsg(
        this.autoStopped ? this.autoStoppedMsg() : { text: t('voice.finishing'), tone: 'muted', long: false }
      );
      this.autoStopped = false;
      this.finishTimer = setTimeout(() => this.recover(tok), FINISH_MS);
      return;
    }
    this.mode = 'pcm'; // 연결 중에 끝냈다 — 스트리밍을 기다리지 않는다
    this.recover(tok);
  }

  private stopped(tok: number) {
    if (tok !== this.token) return;
    const blob = new Blob(this.chunks, { type: this.mime });
    this.chunks = [];
    this.seconds = Math.min(VOICE_MAX_MS / 1000, Math.max(1, Math.round((Date.now() - this.startedAt) / 1000)));
    this.closeMedia();
    this.parts = [{ blob, seconds: this.seconds }];
    if (this.hold) {
      this.hold = false;
      this.set({ phase: 'failed' });
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
      return;
    }
    this.say(t('voice.stopped'));
    void this.transcribe();
  }

  private showHint() {
    const shown = readHintCount();
    if (shown < HINT_TIMES) {
      writeHintCount(shown + 1);
      this.showMsg({ text: t('voice.hint'), tone: 'muted', long: false }, SHORT_MSG_MS); // 처음 3번만(8A)
    } else this.showMsg(null);
  }

  /** 남은 조각을 차례로 일괄 경로(POST /api/chat/transcribe)로 받아쓴다. 받은 글은 모아 한 번에 넣는다 —
   *  중간 조각이 실패하면 그때까지 받은 글을 넣고 남은 조각으로 다시 시도한다 */
  private async transcribe(note: Msg | null = null) {
    const target = this.target;
    if (!this.parts.length || !target) return;
    const tok = this.token;
    const ac = new AbortController();
    this.abort = ac;
    this.set({ phase: 'transcribing', interim: '', connecting: false });
    this.showMsg(note ?? (this.autoStopped ? this.autoStoppedMsg() : null));
    this.autoStopped = false;
    let got = '';
    const put = () => {
      if (!got) return;
      this.insert?.(got, this.append ? { append: true } : undefined);
      this.append = this.append || this.segments > 0;
      got = '';
    };
    try {
      while (this.parts.length) {
        const part = this.parts[0];
        const data_url = await toDataUrl(part.blob);
        if (tok !== this.token) return;
        const r = await post<{ transcript?: string }>(
          '/api/chat/transcribe',
          {
            ...(target.pod ? { pod: target.pod } : {}),
            profile: target.profile,
            mime_type: part.blob.type || this.mime,
            data_url,
            seconds: part.seconds,
            // 소리가 없었는데 Whisper 가 「감사합니다」 같은 말을 지어내면 서버가 버린다(2026-10-23 무음 환각)
            ...(this.metered ? { heard: this.heard } : {}),
          },
          { signal: ac.signal }
        );
        if (tok !== this.token) return;
        this.parts.shift();
        const text = (r.transcript ?? '').trim();
        if (text) got = got ? `${got} ${text}` : text;
      }
      this.abort = null;
      this.set({ phase: 'idle' });
      this.flushSay();
      if (!got && !this.segments) {
        this.showMsg({ text: t('voice.empty'), tone: 'muted', long: false }, SHORT_MSG_MS); // 빈 글은 회색 4초(4A)
        return;
      }
      const inserted = !!got;
      put();
      this.showHint();
      if (inserted) this.say(t('voice.inserted')); // 화면 읽기 알림은 늘 한다(8A)
    } catch (e) {
      if (tok !== this.token) return; // 취소·버림
      this.abort = null;
      put();
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
        this.parts = [];
        this.set({ phase: 'idle' });
        this.showMsg({ text, tone: 'warn', long: true });
        return;
      }
      this.set({ phase: 'failed' }); // 녹음은 메모리에 두고 다시 시도(3A). 실패는 호박색으로 다음 동작까지(4A)
      this.showMsg({ text, tone: 'warn', long: true });
    }
  }

  /** [다시 시도]: 남은 녹음을 다시 보낸다. 연결이 끊겨 있으면 그 안내만(3A) */
  retry(owner: string, blocked: boolean) {
    if (this.snap.owner !== owner || this.snap.phase !== 'failed' || !this.parts.length) return;
    if (blocked) {
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
      return;
    }
    void this.transcribe();
  }

  /** 녹음·받아쓰는 중 연결이 끊겼다: 녹음을 들고 「연결되면 다시 시도」(3A) */
  holdForConnection(owner: string) {
    if (this.snap.owner !== owner) return;
    if (
      this.mode !== 'batch' &&
      (this.snap.phase === 'recording' || (this.snap.phase === 'transcribing' && !this.abort))
    ) {
      // 스트리밍: 마지막 확정 이후의 PCM 을 들고 기다린다(D22 와 같은 소리, 보내는 것은 다시 시도 때)
      this.stopStream();
      this.takePcm();
      this.flushSay();
      if (!this.parts.length) {
        this.set({ phase: 'idle' });
        return;
      }
      this.set({ phase: 'failed' });
      this.showMsg({ text: t('voice.waitConnection'), tone: 'warn', long: true });
      return;
    }
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
    this.stopCapture?.();
    this.stopCapture = null;
    this.closeSocket();
    this.closeMedia();
    if (this.sayTimer) clearTimeout(this.sayTimer);
    this.sayTimer = null;
    this.pendingSay = '';
    this.refining = null;
    this.mode = 'batch';
    this.pcm = [];
    this.segments = 0;
    this.append = false;
    this.parts = [];
    this.chunks = [];
    this.hold = false;
    this.autoStopped = false;
    this.heard = false;
    this.metered = false;
    this.warned = false;
    this.set({ interim: '', connecting: false });
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
  voiceRecorder.snap = initialSnap();
}

const useSnap = () => useSyncExternalStore(voiceRecorder.subscribe, voiceRecorder.getSnap);

/** Composer 가 보는 이 입력칸의 녹음 상태. 원시 값만 돌려 녹음 중 매 틱마다 Composer 가 다시 그려지지 않게 한다 */
export function useVoiceView(owner: string): { busy: boolean; band: boolean; line: boolean } {
  const key = useSyncExternalStore(voiceRecorder.subscribe, () => {
    const s = voiceRecorder.snap;
    if (s.owner !== owner) return '000';
    const busy = ACTIVE.includes(s.phase);
    const band = busy || s.phase === 'failed' || s.phase === 'refining' || (!!s.msg && !s.msg.long);
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
  onEdit,
  suggestOpen,
  rootRef,
}: {
  owner: string;
  voice: VoiceTarget;
  onInsert: Insert;
  onEdit?: VoiceEdit;
  /** 「/」·「@」 고르기 목록이 열려 있으면 Esc 는 목록이 먼저다(E2) */
  suggestOpen: boolean;
  rootRef: RefObject<HTMLElement | null>;
}) {
  const tk = useChatTokens();
  const s = useSnap();
  const supported = useMemo(voiceSupported, []);
  const insertRef = useRef(onInsert);
  insertRef.current = onInsert;
  const editRef = useRef(onEdit);
  editRef.current = onEdit;
  const openRef = useRef(suggestOpen);
  openRef.current = suggestOpen;
  const mine = s.owner === owner;
  const mineActive = mine && ACTIVE.includes(s.phase);
  const other = !mine && ACTIVE.includes(s.phase);
  const blocked = !!voice.blockedReason;
  const btn = useRef<HTMLButtonElement>(null);
  const bandFocus = useRef(false); // 키보드로 이 단추를 눌러 녹음을 시작했다 — 초점을 띠로 옮기고 끝나면 돌려놓는다

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

  // 녹음·받아쓰는 동안은 띠가 ✕ 취소·✓ 끝내기를 맡아 마이크 단추를 그리지 않는다. 같은 회색 마이크·「말로 입력」 툴팁인 채
  // 「녹음 끝내기」로 동작해 시작 단추처럼 보였고 같은 이름 단추가 둘이었다(2026-11-06, 스펙 2026-10-22-005 §8-9).
  // 키보드로 마이크를 눌러 시작했으면 초점을 띠의 단추로 옮기고, 끝나면 마이크로 돌려놓는다(초점이 사라지지 않게)
  useEffect(() => {
    if (mineActive && bandFocus.current) {
      const want = rootRef.current?.querySelector<HTMLElement>(s.phase === 'transcribing' ? '[data-voice-cancel]' : '[data-voice-finish]');
      const inBand = !!document.activeElement?.closest?.('[data-voice-band]');
      if (want && !inBand) want.focus();
    } else if (!mineActive && bandFocus.current) {
      bandFocus.current = false;
      const at = document.activeElement;
      if (!at || at === document.body) btn.current?.focus();
    }
  }, [mineActive, s.phase, rootRef]);

  if (voice.stt !== true || !supported) return null; // stt 값이 온 뒤 한 번에 그린다(23A), 브라우저 조건(§3-10)
  if (mineActive) return null;

  const reason = other ? t('voice.otherWindow') : !mineActive && blocked ? voice.blockedReason : '';
  const tip = voice.sttStream
    ? t('voice.tooltipStream', { min: Math.max(1, Math.round((voice.sttStreamMaxSeconds || STREAM_MAX_SECONDS) / 60)) })
    : t('voice.tooltip');
  const label =
    mine && s.phase === 'recording'
      ? t('voice.finishLabel')
      : mine && s.phase === 'transcribing'
      ? t('voice.cancelTranscribe')
      : t('voice.label');
  const press = () => {
    bandFocus.current = document.activeElement === btn.current;
    if (reason) {
      voice.refresh?.(); // 막힌 마이크를 누르면 연결 상태를 다시 읽는다(M3)
      return;
    }
    if (mine && s.phase === 'recording') return voiceRecorder.finish(owner);
    if (mine && (s.phase === 'transcribing' || s.phase === 'asking')) return voiceRecorder.cancel(owner);
    void voiceRecorder.start(
      owner,
      {
        pod: voice.pod,
        profile: voice.profile,
        stream: voice.sttStream === true,
        maxSeconds: voice.sttStreamMaxSeconds,
      },
      (text, opts) => insertRef.current(text, opts),
      editRef.current && {
        begin: () => editRef.current?.begin(),
        refine: (text) => editRef.current?.refine(text) ?? Promise.resolve(false),
        undo: () => editRef.current?.undo(),
      }
    );
    voice.refresh?.(); // 누를 때 연결 상태를 다시 읽는다(M3). start 가 AudioContext 를 먼저 만든 뒤다(M5)
  };
  return (
    <Tooltip title={reason || tip}>
      <IconButton
        ref={btn}
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

const INTERIM_WIDE = 60;
const INTERIM_NARROW = 20;

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
  const narrow = useMediaQuery('(max-width: 600px)');
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
        data-voice-cancel=""
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
    const late = s.elapsed >= s.maxMs - WARN_BEFORE_MS;
    // 중간 글(D21): 띠 안 회색 한 줄. 길면 뒷부분 위주로 앞에 말줄임 — 좁은 화면은 더 짧게
    const keep = narrow ? INTERIM_NARROW : INTERIM_WIDE;
    const interim = s.interim.length > keep ? `…${s.interim.slice(-keep)}` : s.interim;
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
          {`${clock(s.elapsed)} / ${clock(s.maxMs)}`}
        </Box>
        {s.connecting && (
          <CircularProgress size={12} thickness={5} sx={{ color: tk.muted, flex: '0 0 auto' }} aria-hidden />
        )}
        {/* 스크린리더는 중간 글을 읽지 않는다 — 확정 구간만 알림 영역에서 한 번(D24) */}
        <Box aria-hidden data-voice-interim="" sx={{ ...text, flex: 1, color: tk.muted }}>
          {interim}
        </Box>
        {cancelBtn(t('voice.cancelRecording'))}
        <Tooltip title={t('voice.finishLabel')}>
          <Button
            variant="outlined"
            color="inherit"
            aria-label={t('voice.finishLabel')}
            data-voice-finish=""
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
  } else if (s.phase === 'refining') {
    // 2차 대기(D13). 보내기는 풀려 있고 보내면 남은 결과는 버린다(D14) — 취소 단추는 두지 않는다
    body = (
      <>
        <CircularProgress size={12} thickness={5} sx={{ color: tk.muted, flex: '0 0 auto' }} aria-hidden />
        <Box role="status" sx={{ ...text, color: tk.muted }}>
          {t('voice.refining')}
        </Box>
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
      <>
        <Box role="status" sx={{ ...text, color: color(s.msg) }}>
          {s.msg.text}
        </Box>
        {s.msg.undo && (
          <Button
            size="small"
            color="inherit"
            onPointerDown={keepFocus}
            onClick={() => voiceRecorder.undo(owner)}
            sx={{ color: tk.text, fontSize: chatType.meta, minWidth: 0, px: 1, ...touch }}
          >
            {t('voice.undo')}
          </Button>
        )}
      </>
    );
  }
  if (!body) return null;
  // 짧은 상태 문구는 띠 자리에 role=status 로(4A). 할 일이 있는 긴 안내는 VoiceLine 이 띠 아래에 보인다(R14)
  return (
    <Box id={id} data-voice-band="" sx={{ display: 'flex', alignItems: 'center', gap: 0.75, flex: 1, minWidth: 0 }}>
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
  stt_stream?: boolean;
  stt_stream_max_seconds?: number;
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
    sttStream: d?.stt_stream === true,
    sttStreamMaxSeconds: d?.stt_stream_max_seconds,
    // 상태에 error 가 있거나 상태 읽기 자체가 실패하면 막는다. connected:false 는 막지 않는다(채팅 웹소켓은 대화를 보낼 때만 열린다)
    blockedReason: d && (d.error || q.isError) ? t('voice.blockedMine') : undefined,
    refresh: () => void q.refetch(),
    tts: d ? d.tts === true : undefined,
    ttsVoices: d?.tts_voices,
  };
}

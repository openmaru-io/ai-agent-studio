/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스트리밍 받아쓰기(OMAI-1554)의 브라우저 쪽 도구: 소리 잡기(AudioWorklet), 웹소켓 열기, PCM → WAV.
// 계약은 docs-plan/deploy/stt-stream-protocol.md(2026-10-31-002) 하나다. 상태 기계는 VoiceInput.tsx 의 VoiceRecorder 에 있다.
// sttDeps 는 시험이 바꿔 끼운다(jsdom 에는 AudioWorklet·실제 웹소켓 서버가 없다).
// no-inline: 4KB 보다 작아 data: 주소로 묶이지 않게 파일로 낸다(AudioWorklet 은 같은 출처 파일을 부른다)
import workletUrl from './pcm16Worklet.js?url&no-inline';

export const STREAM_PATH = '/api/chat/transcribe/stream';
export const PCM_RATE = 16000;
export const PCM_BYTES_PER_SECOND = PCM_RATE * 2;
/** 일괄 경로 한 번에 보낼 PCM 길이. 서버 본문 상한(TRANSCRIBE_MAX_BODY 2MB, base64 로 4/3 배)에 들게 40초(약 1.7MB)씩 나눈다 */
export const BATCH_PART_SECONDS = 40;

/** 서버 → 화면 메시지(계약 §2) */
export type StreamMsg =
  | { type: 'ready'; session?: string; max_seconds?: number }
  | { type: 'interim'; text?: string; seq?: number }
  | { type: 'segment'; id?: number; text?: string }
  | { type: 'final'; text?: string; pending?: number }
  | { type: 'refined'; text?: string }
  | { type: 'done' }
  | { type: 'error'; code?: string; message?: string };

export interface SttDeps {
  /** 이 브라우저·이 AudioContext 로 스트리밍할 수 있는가 */
  supported: (ctx: AudioContext | null) => boolean;
  /** 마이크 소리를 16kHz PCM16 조각(ArrayBuffer)으로 onChunk 에 넘긴다. 돌려준 함수를 부르면 멈춘다 */
  capture: (ctx: AudioContext, stream: MediaStream, onChunk: (buf: ArrayBuffer) => void) => Promise<() => void>;
  socket: (url: string) => WebSocket;
}

const defaultDeps: SttDeps = {
  supported: (ctx) =>
    !!ctx &&
    !!(ctx as { audioWorklet?: unknown }).audioWorklet &&
    typeof AudioWorkletNode !== 'undefined' &&
    typeof WebSocket !== 'undefined',
  capture: async (ctx, stream, onChunk) => {
    await ctx.audioWorklet.addModule(workletUrl);
    const src = ctx.createMediaStreamSource(stream);
    const node = new AudioWorkletNode(ctx, 'aas-pcm16', {
      numberOfInputs: 1,
      numberOfOutputs: 1,
      channelCount: 1,
      channelCountMode: 'explicit',
    });
    node.port.onmessage = (e: MessageEvent) => onChunk(e.data as ArrayBuffer);
    src.connect(node);
    node.connect(ctx.destination); // 출력은 늘 무음이다. 목적지에 이어야 처리를 멈추지 않는 브라우저가 있다
    return () => {
      node.port.onmessage = null;
      try {
        src.disconnect();
        node.disconnect();
      } catch {
        // 이미 끊겼다
      }
    };
  },
  socket: (url) => new WebSocket(url),
};

export const sttDeps: SttDeps = { ...defaultDeps };

/** 시험용: 기본 도구로 되돌린다 */
export function resetSttDeps(over: Partial<SttDeps> = {}) {
  Object.assign(sttDeps, defaultDeps, over);
}

/** 같은 주소·같은 scheme(https 면 wss)의 스트림 주소. 쿠키·Origin 은 브라우저가 붙인다 */
export function streamUrl(target: { pod?: string; profile: string }): string {
  const q = new URLSearchParams();
  if (target.pod) q.set('pod', target.pod);
  q.set('profile', target.profile);
  const scheme = window.location.protocol === 'https:' ? 'wss' : 'ws';
  return `${scheme}://${window.location.host}${STREAM_PATH}?${q.toString()}`;
}

/** PCM16 LE 16kHz 모노 조각들을 WAV(RIFF) 하나로. 브라우저의 Int16Array 는 리틀 엔디언이다(지원하는 모든 플랫폼) */
export function wavFromPcm(chunks: ArrayBuffer[]): Blob {
  const bytes = chunks.reduce((n, c) => n + c.byteLength, 0);
  const head = new DataView(new ArrayBuffer(44));
  const str = (at: number, s: string) => [...s].forEach((ch, i) => head.setUint8(at + i, ch.charCodeAt(0)));
  str(0, 'RIFF');
  head.setUint32(4, 36 + bytes, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  head.setUint32(16, 16, true);
  head.setUint16(20, 1, true); // PCM
  head.setUint16(22, 1, true); // 모노
  head.setUint32(24, PCM_RATE, true);
  head.setUint32(28, PCM_BYTES_PER_SECOND, true);
  head.setUint16(32, 2, true);
  head.setUint16(34, 16, true);
  str(36, 'data');
  head.setUint32(40, bytes, true);
  return new Blob([head.buffer, ...chunks], { type: 'audio/wav' });
}

/** 일괄 경로로 보낼 WAV 들: BATCH_PART_SECONDS 씩 나눈다. 소리가 없으면 [] */
export function wavParts(chunks: ArrayBuffer[]): { blob: Blob; seconds: number }[] {
  const limit = BATCH_PART_SECONDS * PCM_BYTES_PER_SECOND;
  const parts: { blob: Blob; seconds: number }[] = [];
  let cur: ArrayBuffer[] = [];
  let size = 0;
  const flush = () => {
    if (!size) return;
    parts.push({ blob: wavFromPcm(cur), seconds: Math.max(1, Math.round(size / PCM_BYTES_PER_SECOND)) });
    cur = [];
    size = 0;
  };
  for (const c of chunks) {
    if (size + c.byteLength > limit) flush();
    cur.push(c);
    size += c.byteLength;
  }
  flush();
  return parts;
}

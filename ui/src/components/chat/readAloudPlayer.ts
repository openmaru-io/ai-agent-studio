/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「읽어 주기」 재생기(스펙 2026-10-28-012 §3-9·§3-9-1). 화면 전체에 하나다 — 「녹음기는 하나」(VoiceInput) 옆의 「재생기는 하나」(DD9).
// 화면은 글을 나누지 않는다. 답 전체와 조각 번호를 서버(/api/chat/speak)에 보내고, 받은 X-Speak-Parts 만큼 번호를 올리며 차례로 받는다.
// 재생 중인 조각 뒤로 두 조각까지 받아 두고(D21), 요청은 한 번에 하나만 보낸다(사람별 한도 1, D16).
// 429 다시 시도: 첫 조각은 1초 간격 8번까지(D19), 둘째 조각부터는 재생 중에 1초 간격으로 계속, 재생이 끝난 뒤 한 번 더(D18).
// 멈추면 진행 중 요청을 끊고(AbortController) 받아 둔 조각과 다시 시도를 버린다. 재생은 <audio> 하나에 대기열을 둔다(R3).
import { getLang, t } from '@/i18n';

export interface SpeakRequest {
  /** 재생 상태 키 (대화 id, 메시지 고유값) — 배열 위치가 아니다(F11) */
  conv: string;
  msg: string;
  /** 읽는 중 띠에 보일 에이전트 이름(DD4) */
  name: string;
  pod?: string;
  profile: string;
  /** 답 전체. 다듬기·나누기는 서버가 한다(§3-8) */
  text: string;
  voice: string;
}

export type ReadPhase = 'idle' | 'preparing' | 'playing' | 'empty' | 'failed' | 'busy';

export interface ReadSnap {
  conv: string;
  msg: string;
  name: string;
  phase: ReadPhase;
  /** 준비가 3초를 넘었다 — 「준비하는 중…」(DD5) */
  slow: boolean;
  /** 서버가 앞부분만 읽는다(X-Speak-Truncated) */
  truncated: boolean;
  /** 설정 › 내 화면에서 미리 듣는 목소리 id. 없으면 '' */
  preview: string;
  /** 화면 읽기 알림(시작·끝·실패·잘림, DD17). n 이 바뀌면 같은 글도 다시 읽는다 */
  announce: { n: number; text: string; conv: string };
}

/** <audio> 에서 쓰는 것만 */
export interface AudioLike {
  src: string;
  play(): Promise<void> | void;
  pause(): void;
  onended: (() => void) | null;
  onerror: (() => void) | null;
}

export interface PlayerDeps {
  fetch: (url: string, init: RequestInit) => Promise<Response>;
  makeAudio: () => AudioLike | null;
  createUrl: (b: Blob) => string;
  revokeUrl: (u: string) => void;
}

/** 재생 중인 조각 뒤로 받아 둘 조각 수(D21) */
export const AHEAD = 2;
/** 첫 조각의 429 다시 시도 횟수(D19) */
export const FIRST_RETRIES = 8;
export const RETRY_MS = 1000;
export const SLOW_MS = 3000;
export const EMPTY_MS = 4000;

const ACTIVE: ReadPhase[] = ['preparing', 'playing'];
const IDLE: ReadSnap = { conv: '', msg: '', name: '', phase: 'idle', slow: false, truncated: false, preview: '', announce: { n: 0, text: '', conv: '' } };

/** Safari 잠금 풀기용 짧은 무음(0.1초 8kHz 8bit). 화면 안에서 만들어 외부에 요청하지 않는다(에어갭) */
function silentWav(): string {
  const n = 800;
  const bytes = new Uint8Array(44 + n);
  const v = new DataView(bytes.buffer);
  const str = (o: number, s: string) => [...s].forEach((c, i) => v.setUint8(o + i, c.charCodeAt(0)));
  str(0, 'RIFF');
  v.setUint32(4, 36 + n, true);
  str(8, 'WAVE');
  str(12, 'fmt ');
  v.setUint32(16, 16, true);
  v.setUint16(20, 1, true); // PCM
  v.setUint16(22, 1, true); // 단일 채널
  v.setUint32(24, 8000, true);
  v.setUint32(28, 8000, true);
  v.setUint16(32, 1, true);
  v.setUint16(34, 8, true);
  str(36, 'data');
  v.setUint32(40, n, true);
  bytes.fill(128, 44); // 8bit PCM 의 0 은 128
  let bin = '';
  bytes.forEach((b) => (bin += String.fromCharCode(b)));
  return 'data:audio/wav;base64,' + btoa(bin);
}
let SILENT = '';

const defaultDeps = (): PlayerDeps => ({
  fetch: (u, i) => fetch(u, i),
  makeAudio: () => (typeof Audio === 'undefined' ? null : (new Audio() as unknown as AudioLike)),
  createUrl: (b) => URL.createObjectURL(b),
  revokeUrl: (u) => URL.revokeObjectURL(u),
});

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

export class ReadAloudPlayer {
  snap: ReadSnap = IDLE;
  private listeners = new Set<() => void>();
  private audio: AudioLike | null = null;
  /** 멈추기·새 읽기마다 올린다. 늦게 끝난 비동기 일은 이 값이 다르면 아무것도 하지 않는다 */
  private token = 0;
  private abort: AbortController | null = null;
  private req: SpeakRequest | null = null;
  /** 조각 수. 첫 응답 전에는 -1 */
  private parts = -1;
  /** 받아 둔 조각(번호 → 소리 주소) */
  private buffer = new Map<number, string>();
  private playingUrl = '';
  /** 지금 재생 중인 조각. 없으면 -1 */
  private playing = -1;
  /** 다음에 재생할 조각 */
  private expect = 0;
  /** 다음에 받을 조각 */
  private nextFetch = 0;
  /** 이번 읽기(처음 또는 다시 시도)의 첫 요청 번호 — 이 조각만 첫 조각 규칙(D19)으로 다시 시도한다 */
  private firstPart = 0;
  private fetching = false;
  /** 재생이 끝났는데 다음 조각이 아직 없다 */
  private starved = false;
  /** 재생이 끝난 뒤 보낸 요청 수(D18 「한 번 더」) */
  private sentAfterEnd = 0;
  /** 받지 못한 조각. 앞 조각을 다 재생한 뒤 실패로 보인다 */
  private failAt: { part: number; kind: 'failed' | 'busy' } | null = null;
  /** [다시 시도]가 읽기 시작할 조각(DD7) */
  private resumePart = 0;
  private slowTimer: ReturnType<typeof setTimeout> | null = null;
  private emptyTimer: ReturnType<typeof setTimeout> | null = null;

  constructor(private deps: PlayerDeps = defaultDeps()) {}

  /** 시험용: 의존성을 바꾼다 */
  setDeps(d: Partial<PlayerDeps>) {
    this.deps = { ...this.deps, ...d };
    this.audio = null;
  }

  subscribe = (fn: () => void) => {
    this.listeners.add(fn);
    return () => void this.listeners.delete(fn);
  };
  getSnap = () => this.snap;
  private set(p: Partial<ReadSnap>) {
    this.snap = { ...this.snap, ...p };
    this.listeners.forEach((f) => f());
  }
  /** conv: 알림을 읽을 입력칸의 대화. 끝난 뒤에는 snap.conv 가 비므로 넘겨받는다 */
  private say(text: string, conv = this.snap.conv) {
    this.set({ announce: { n: this.snap.announce.n + 1, text, conv } });
  }

  /** 읽기·준비 중인가 */
  active(): boolean {
    return ACTIVE.includes(this.snap.phase);
  }
  /** 소리를 내거나 곧 낼 참인가 — 오피스 배경음악을 이 동안 멈춘다(DD10) */
  audible(): boolean {
    return this.active() || !!this.snap.preview;
  }
  /** 이 행이 지금 이 재생기의 대상인가 */
  isRow(conv: string, msg: string): boolean {
    return this.snap.conv === conv && this.snap.msg === msg && this.snap.phase !== 'idle';
  }

  private el(): AudioLike | null {
    if (!this.audio) this.audio = this.deps.makeAudio();
    return this.audio;
  }

  /** Safari 는 사용자 동작 직후가 아닌 play() 를 막는다. 클릭 처리기 안에서 첫 await 전에 같은 <audio> 로 무음을 틀어 잠금을 푼다(OV-M6) */
  private unlock() {
    const a = this.el();
    if (!a) return;
    try {
      a.onended = null;
      a.onerror = null;
      a.src = SILENT || (SILENT = silentWav());
      const p = a.play();
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(() => undefined);
    } catch {
      // 잠금 풀기에 실패해도 읽기는 해 본다
    }
  }

  /** [읽어 주기]: 같은 행이 읽는 중이면 멈추고, 아니면 처음부터 읽는다(DD8, 일시정지 없음) */
  press(req: SpeakRequest) {
    if (this.snap.conv === req.conv && this.snap.msg === req.msg && this.active()) {
      this.stop();
      return;
    }
    this.start(req, 0);
  }

  /** [다시 시도]: 실패한 조각부터 읽는다(DD7) */
  retry() {
    const req = this.req;
    if (!req || (this.snap.phase !== 'failed' && this.snap.phase !== 'busy')) return;
    this.start(req, this.resumePart, this.parts);
  }

  start(req: SpeakRequest, from = 0, knownParts = -1) {
    this.reset();
    this.unlock(); // 첫 await 전
    const tok = this.token;
    this.req = req;
    this.parts = knownParts;
    this.expect = from;
    this.nextFetch = from;
    this.firstPart = from;
    this.resumePart = from;
    this.set({ conv: req.conv, msg: req.msg, name: req.name, phase: 'preparing', slow: false, truncated: false, preview: '' });
    this.slowTimer = setTimeout(() => {
      this.slowTimer = null;
      if (tok === this.token && this.snap.phase === 'preparing') this.set({ slow: true });
    }, SLOW_MS);
    this.say(t('read.started'));
    this.pump();
  }

  /** 멈추기·대화 바꾸기·창 닫기·화면 이동(DD11): 요청을 끊고 받은 것을 버린다. 문구를 남기지 않는다(DD8) */
  stop() {
    if (this.snap.phase === 'idle' && !this.snap.preview && !this.fetching) return;
    this.reset();
    this.set({ ...IDLE, announce: this.snap.announce });
  }

  /** 이 대화의 읽기만 멈춘다(대화를 바꾸거나 창을 닫을 때) */
  stopConv(conv: string) {
    if (conv && this.snap.conv === conv) this.stop();
  }

  private reset() {
    this.token++;
    this.abort?.abort();
    this.abort = null;
    this.fetching = false;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    if (this.emptyTimer) clearTimeout(this.emptyTimer);
    this.slowTimer = null;
    this.emptyTimer = null;
    this.buffer.forEach((u) => this.deps.revokeUrl(u));
    this.buffer.clear();
    if (this.playingUrl) this.deps.revokeUrl(this.playingUrl);
    this.playingUrl = '';
    this.playing = -1;
    this.starved = false;
    this.sentAfterEnd = 0;
    this.failAt = null;
    if (this.audio) {
      this.audio.onended = null;
      this.audio.onerror = null;
      try {
        this.audio.pause();
      } catch {
        // 이미 멈췄다
      }
    }
  }

  /** 받을 조각이 있으면 하나 요청한다. 받아 둔 조각(+진행 중 요청)이 재생 중 조각 뒤로 두 개를 넘지 않게(D21) */
  private pump() {
    if (this.fetching || this.failAt || !this.req) return;
    if (this.parts >= 0 && this.nextFetch >= this.parts) return;
    if (this.buffer.size >= AHEAD) return;
    void this.fetchPart(this.nextFetch);
  }

  private async fetchPart(n: number) {
    const req = this.req as SpeakRequest;
    const tok = this.token;
    const first = n === this.firstPart;
    this.fetching = true;
    let tries = 0;
    for (;;) {
      const ac = new AbortController();
      this.abort = ac;
      if (this.starved) this.sentAfterEnd++;
      let res: Response;
      try {
        res = await this.deps.fetch('/api/chat/speak', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json', 'X-AAS': '1', 'Accept-Language': getLang() },
          body: JSON.stringify({ ...(req.pod ? { pod: req.pod } : {}), profile: req.profile, text: req.text, voice: req.voice, part: n }),
          signal: ac.signal,
        });
      } catch {
        if (tok !== this.token) return; // 멈춤
        return this.failPart(n, 'failed');
      }
      if (tok !== this.token) return;
      if (res.status === 200) {
        let blob: Blob;
        try {
          blob = await res.blob();
        } catch {
          if (tok !== this.token) return;
          return this.failPart(n, 'failed');
        }
        if (tok !== this.token) return;
        const parts = Number(res.headers.get('X-Speak-Parts'));
        if (Number.isFinite(parts) && parts > 0) this.parts = parts;
        if (res.headers.get('X-Speak-Truncated') === '1' && !this.snap.truncated) {
          this.set({ truncated: true });
          this.say(t('read.truncated'));
        }
        this.abort = null;
        this.fetching = false;
        this.buffer.set(n, this.deps.createUrl(blob));
        this.nextFetch = n + 1;
        if (this.playing < 0) this.playNext();
        this.pump();
        return;
      }
      if (res.status === 204) {
        this.abort = null;
        this.fetching = false;
        if (n === 0 && first) return this.showEmpty();
        // 둘째 조각부터의 204 는 읽을 글이 거기서 끝난 것으로 본다
        this.parts = n;
        if (this.playing < 0) this.playNext();
        return;
      }
      if (res.status === 429) {
        if (first) {
          if (tries >= FIRST_RETRIES) return this.failPart(n, 'busy');
          tries++;
        } else if (this.starved && this.sentAfterEnd >= 1) return this.failPart(n, 'busy');
        await sleep(RETRY_MS);
        if (tok !== this.token) return;
        continue;
      }
      return this.failPart(n, 'failed');
    }
  }

  private failPart(n: number, kind: 'failed' | 'busy') {
    this.abort = null;
    this.fetching = false;
    this.failAt = { part: n, kind };
    // 받아 둔 앞 조각은 끝까지 재생하고, 그다음에 실패를 보인다
    if (this.playing < 0) this.playNext();
  }

  private playNext() {
    const need = this.expect;
    const url = this.buffer.get(need);
    if (!url) {
      if (this.parts >= 0 && need >= this.parts) return this.finish();
      if (this.failAt && this.failAt.part === need) return this.enterFail(need, this.failAt.kind);
      if (!this.starved) {
        this.starved = true;
        this.sentAfterEnd = 0;
      }
      this.pump();
      return;
    }
    const a = this.el();
    if (!a) return this.enterFail(need, 'failed');
    const tok = this.token;
    this.buffer.delete(need);
    this.playing = need;
    this.expect = need + 1;
    this.starved = false;
    this.playingUrl = url;
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    a.onended = () => {
      if (tok !== this.token) return;
      this.deps.revokeUrl(url);
      this.playingUrl = '';
      this.playing = -1;
      this.playNext();
      this.pump();
    };
    a.onerror = () => {
      if (tok !== this.token) return;
      this.enterFail(need, 'failed');
    };
    a.src = url;
    if (this.snap.phase !== 'playing') this.set({ phase: 'playing', slow: false });
    try {
      const p = a.play();
      if (p && typeof (p as Promise<void>).catch === 'function')
        (p as Promise<void>).catch(() => {
          if (tok === this.token && this.playing === need) this.enterFail(need, 'failed');
        });
    } catch {
      this.enterFail(need, 'failed');
    }
    this.pump();
  }

  private enterFail(part: number, kind: 'failed' | 'busy') {
    const req = this.req;
    const parts = this.parts;
    const keep = { conv: this.snap.conv, msg: this.snap.msg, name: this.snap.name, truncated: false };
    this.reset();
    this.req = req;
    this.parts = parts;
    this.resumePart = part;
    this.set({ ...keep, phase: kind, slow: false });
    this.say(kind === 'busy' ? t('read.busy') : t('read.failed'));
  }

  private showEmpty() {
    if (this.slowTimer) clearTimeout(this.slowTimer);
    this.slowTimer = null;
    const tok = this.token;
    this.set({ phase: 'empty', slow: false });
    this.say(t('read.empty'));
    this.emptyTimer = setTimeout(() => {
      this.emptyTimer = null;
      if (tok === this.token && this.snap.phase === 'empty') this.set({ ...IDLE, announce: this.snap.announce });
    }, EMPTY_MS);
  }

  private finish() {
    const conv = this.snap.conv;
    this.reset();
    this.req = null;
    this.set({ ...IDLE, announce: this.snap.announce });
    this.say(t('read.finished'), conv); // 끝은 조용히, 화면 읽기에만 알린다(DD8)
  }

  /** 설정 › 내 화면의 [미리 듣기](R11). 채팅 읽기를 멈춘다(재생기 하나). 같은 목소리를 다시 누르면 멈춘다 */
  async preview(voice: string) {
    if (this.snap.preview === voice) {
      this.stop();
      return;
    }
    this.reset();
    this.unlock();
    this.req = null;
    this.set({ ...IDLE, announce: this.snap.announce, preview: voice });
    const tok = this.token;
    const ac = new AbortController();
    this.abort = ac;
    try {
      const res = await this.deps.fetch('/api/tts/preview', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-AAS': '1', 'Accept-Language': getLang() },
        body: JSON.stringify({ voice }),
        signal: ac.signal,
      });
      if (tok !== this.token) return;
      if (res.status !== 200) throw new Error(String(res.status));
      const blob = await res.blob();
      if (tok !== this.token) return;
      const a = this.el();
      if (!a) throw new Error('audio');
      const url = this.deps.createUrl(blob);
      this.playingUrl = url;
      const done = () => {
        if (tok !== this.token) return;
        this.stop();
      };
      a.onended = done;
      a.onerror = done;
      a.src = url;
      const p = a.play();
      if (p && typeof (p as Promise<void>).catch === 'function') (p as Promise<void>).catch(done);
    } catch {
      if (tok === this.token) this.stop(); // 미리 듣기 실패는 조용히 원래대로
    }
  }
}

export const readAloud = new ReadAloudPlayer();

/** 시험용: 재생기를 처음 상태로 */
export function resetReadAloud(deps?: Partial<PlayerDeps>) {
  readAloud.stop();
  readAloud.snap = IDLE;
  if (deps) readAloud.setDeps(deps);
}

// ---- 고른 목소리(설정 › 내 화면, DD19) --------------------------------------
// 이 브라우저에 저장한다(내 화면의 다른 값과 같다). 고르지 않았으면 첫 목소리.
export const VOICE_KEY = 'aas.tts.voice';
const voiceListeners = new Set<() => void>();
let memoVoice = '';

export function readVoicePref(): string {
  try {
    return localStorage.getItem(VOICE_KEY) ?? memoVoice;
  } catch {
    return memoVoice;
  }
}
export function saveVoicePref(id: string) {
  memoVoice = id;
  try {
    localStorage.setItem(VOICE_KEY, id);
  } catch {
    // 저장소가 막혀 있으면 이번 화면에서만 기억한다
  }
  voiceListeners.forEach((f) => f());
}
export function subscribeVoicePref(f: () => void) {
  voiceListeners.add(f);
  return () => void voiceListeners.delete(f);
}

export interface TtsVoice {
  id: string;
  /** 글 하나 또는 {"ko","en"} */
  name: string | { ko?: string; en?: string };
  gender?: string;
}

/** 쓸 목소리: 고른 값이 목록에 있으면 그것, 아니면 첫 목소리. 읽는 도중 바꾼 값은 다음 읽기부터 쓴다(DD19) */
export function pickVoice(voices: TtsVoice[] | undefined): string {
  const list = voices ?? [];
  const want = readVoicePref();
  return list.some((v) => v.id === want) ? want : list[0]?.id ?? '';
}

export function voiceName(v: TtsVoice): string {
  const n = v.name;
  if (typeof n === 'string') return n || v.id;
  return n?.[getLang()] || n?.ko || n?.en || v.id;
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 말로 입력 시험의 대역(스펙 2026-10-22-005 §11 M8): jsdom 에 없는 MediaRecorder·getUserMedia·AudioContext 를 바꿔 끼운다.
// 음량은 level 로 정한다(0 이면 무음). 마이크 오류는 fail 에 DOMException 이름을 준다.
import { vi } from 'vitest';

export interface FakeMedia {
  /** 만들어진 녹음기들 */
  recorders: FakeRecorder[];
  /** 마이크 트랙들 — stop() 이 불렸는지 본다(21A) */
  tracks: { stop: ReturnType<typeof vi.fn>; kind: string }[];
  getUserMedia: ReturnType<typeof vi.fn>;
  /** 입력 음량 RMS(0~1) */
  level: number;
  /** 다음 getUserMedia 를 이 이름의 오류로 거절한다 */
  fail: string;
  /** 다음 getUserMedia 를 붙잡아 둔다(권한 대기). 풀려면 release() */
  holdPermission: boolean;
  release: () => void;
  audioContexts: { resume: ReturnType<typeof vi.fn>; close: ReturnType<typeof vi.fn> }[];
}

export class FakeRecorder {
  static supported = ['audio/webm;codecs=opus', 'audio/mp4'];
  static isTypeSupported = (m: string) => FakeRecorder.supported.includes(m);
  state: 'inactive' | 'recording' = 'inactive';
  ondataavailable: ((e: { data: Blob }) => void) | null = null;
  onstop: (() => void) | null = null;
  constructor(readonly stream: unknown, readonly options: { mimeType?: string; audioBitsPerSecond?: number }) {
    media?.recorders.push(this);
  }
  start() {
    this.state = 'recording';
  }
  stop() {
    if (this.state === 'inactive') return;
    this.state = 'inactive';
    const type = (this.options.mimeType ?? 'audio/webm').split(';')[0];
    this.ondataavailable?.({ data: new Blob(['소리'], { type }) });
    this.onstop?.();
  }
}

let media: FakeMedia | null = null;

/** 대역을 끼운다. 시험이 끝나면 vi.unstubAllGlobals() 와 함께 uninstallFakeMedia() 를 부른다 */
export function installFakeMedia(opts: { mimes?: string[]; secure?: boolean } = {}): FakeMedia {
  FakeRecorder.supported = opts.mimes ?? ['audio/webm;codecs=opus', 'audio/mp4'];
  let releaseFn: () => void = () => undefined;
  const m: FakeMedia = {
    recorders: [],
    tracks: [],
    level: 0.3,
    fail: '',
    holdPermission: false,
    release: () => releaseFn(),
    audioContexts: [],
    getUserMedia: vi.fn(() => {
      if (m.fail) {
        const name = m.fail;
        m.fail = '';
        return Promise.reject(Object.assign(new Error(name), { name }));
      }
      const track = { stop: vi.fn(), kind: 'audio' };
      m.tracks.push(track);
      const stream = { getTracks: () => [track] };
      if (m.holdPermission) return new Promise((resolve) => (releaseFn = () => resolve(stream)));
      return Promise.resolve(stream);
    }),
  };
  media = m;
  vi.stubGlobal('MediaRecorder', FakeRecorder);
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: { getUserMedia: m.getUserMedia } });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: opts.secure ?? true });
  class FakeAudioContext {
    resume = vi.fn(() => Promise.resolve());
    close = vi.fn(() => Promise.resolve());
    constructor() {
      m.audioContexts.push(this);
    }
    createAnalyser() {
      return {
        fftSize: 32,
        connect: () => undefined,
        // 128 이 무음, 진폭은 level 로
        getByteTimeDomainData: (buf: Uint8Array) =>
          buf.forEach((_, i) => (buf[i] = 128 + (i % 2 ? 1 : -1) * Math.round(m.level * 127))),
      };
    }
    createMediaStreamSource() {
      return { connect: () => undefined };
    }
  }
  vi.stubGlobal('AudioContext', FakeAudioContext);
  return m;
}

export function uninstallFakeMedia() {
  media = null;
  Object.defineProperty(navigator, 'mediaDevices', { configurable: true, value: undefined });
  Object.defineProperty(window, 'isSecureContext', { configurable: true, value: false });
}

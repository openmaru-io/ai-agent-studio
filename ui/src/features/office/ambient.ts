/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 배경음(계획 007 P8). 고른 곡(스펙 2026-10-21-014, audio/tracks.ts)을 되풀이해 튼다.
// 곡은 화면 묶음 안에 있어 외부에 요청하지 않는다. 기본은 끔이고, 켜기와 고른 곡은 이 브라우저에 기억한다.
import { useCallback, useEffect, useRef, useState, useSyncExternalStore } from 'react';

import { readAloud } from '@/components/chat/readAloudPlayer';

import { DEFAULT_TRACK_ID, trackById } from './audio/tracks';

const PREF_KEY = 'aas.office.ambient';
const TRACK_KEY = 'aas.office.ambient.track';
// 곡 파일을 -16 LUFS 로 맞추고 0.4 로 튼다(약 -24 LUFS). 옛 곡은 -27 LUFS 를 0.3 으로 틀어 너무 작았다(사용자 2026-10-21)
export const VOLUME = 0.4;
const FADE_MS = 2000;
/** 곡을 바꿀 때 앞 곡을 줄이는 시간 */
export const SWITCH_OUT_MS = 1000;

export function readPref(): boolean {
  try {
    return localStorage.getItem(PREF_KEY) === 'on';
  } catch {
    return false;
  }
}

function writePref(on: boolean): void {
  try {
    localStorage.setItem(PREF_KEY, on ? 'on' : 'off');
  } catch {
    /* 저장소가 막혀 있으면 이번 화면에서만 기억한다 */
  }
}

// 고른 곡: 설정 화면과 오피스 화면이 같은 값을 본다. 같은 탭은 직접 알리고, 다른 탭은 storage 이벤트로 받는다.
let memoTrack: string | null = null;
const listeners = new Set<() => void>();

export function readTrack(): string {
  let saved: string | null = memoTrack;
  try {
    saved = localStorage.getItem(TRACK_KEY) ?? memoTrack;
  } catch {
    /* 저장소가 막혀 있으면 이번 화면의 값 */
  }
  return trackById(saved ?? DEFAULT_TRACK_ID).id;
}

export function saveTrack(id: string): void {
  memoTrack = id;
  try {
    localStorage.setItem(TRACK_KEY, id);
  } catch {
    /* 저장소가 막혀 있으면 이번 화면에서만 기억한다 */
  }
  listeners.forEach((f) => f());
}

export function subscribeTrack(f: () => void): () => void {
  const onStorage = (e: StorageEvent) => {
    if (e.key === TRACK_KEY) f();
  };
  listeners.add(f);
  window.addEventListener('storage', onStorage);
  return () => {
    listeners.delete(f);
    window.removeEventListener('storage', onStorage);
  };
}

export function useTrack(): string {
  return useSyncExternalStore(subscribeTrack, readTrack);
}

type MakeAudio = (url: string) => HTMLAudioElement | null;

/** 곡을 틀고 멈추고 바꾼다. 시험에서 Audio 를 바꿔 넣을 수 있다. */
export class Ambient {
  private audio: HTMLAudioElement | null = null;
  private fade: ReturnType<typeof setInterval> | null = null;
  /** 곡을 바꾸며 소리를 줄이는 중인 앞 곡들 */
  private leaving = new Map<HTMLAudioElement, ReturnType<typeof setInterval>>();

  constructor(
    private url: string,
    private readonly make: MakeAudio = (u) => (typeof Audio === 'undefined' ? null : new Audio(u)),
  ) {}

  get playing(): boolean {
    return this.audio !== null;
  }

  /** 틀기. 브라우저가 사용자 조작 전 재생을 막으면 거짓 — 다음 클릭에서 다시 부른다. */
  async start(): Promise<boolean> {
    const a = this.audio ?? this.make(this.url);
    if (!a) return false;
    this.audio = a;
    a.loop = true;
    if (!a.paused) return true;
    a.volume = 0;
    try {
      await a.play();
    } catch {
      if (this.audio === a) this.audio = null;
      return false;
    }
    if (this.audio !== a) {
      a.pause(); // 기다리는 사이에 멈추거나 다른 곡으로 바뀌었다
      return false;
    }
    this.fadeTo(VOLUME); // 갑자기 커지지 않게 2초에 걸쳐 올린다
    return true;
  }

  stop(): void {
    if (this.fade) clearInterval(this.fade);
    this.fade = null;
    this.audio?.pause();
    this.audio = null;
    this.leaving.forEach((timer, a) => {
      clearInterval(timer);
      a.pause();
    });
    this.leaving.clear();
  }

  /** 곡 바꾸기. 재생 중이면 앞 곡을 1초에 걸쳐 줄여 멈추고 새 곡을 튼다. 아니면 다음 start() 가 새 곡으로 튼다. */
  async switchTo(url: string): Promise<boolean> {
    if (url === this.url) return this.playing;
    this.url = url;
    const old = this.audio;
    if (!old) return false;
    if (this.fade) clearInterval(this.fade);
    this.fade = null;
    this.audio = null;
    this.fadeOut(old);
    return this.start();
  }

  private fadeOut(a: HTMLAudioElement): void {
    const step = Math.max(a.volume, 0.01) / (SWITCH_OUT_MS / 100);
    const timer = setInterval(() => {
      a.volume = Math.max(0, a.volume - step);
      if (a.volume <= 0) {
        clearInterval(timer);
        this.leaving.delete(a);
        a.pause();
      }
    }, 100);
    this.leaving.set(a, timer);
  }

  private fadeTo(target: number): void {
    const a = this.audio;
    if (!a) return;
    if (this.fade) clearInterval(this.fade);
    const step = target / (FADE_MS / 100);
    this.fade = setInterval(() => {
      a.volume = Math.min(target, a.volume + step);
      if (a.volume >= target && this.fade) {
        clearInterval(this.fade);
        this.fade = null;
      }
    }, 100);
  }
}

/** 배경음 켜기·끄기와 곡 고르기. 기억해 둔 설정이 켜짐이어도 브라우저는 사용자 조작 전에는 소리를 막으므로, 막히면 첫 클릭에서 튼다. */
export function useAmbient() {
  const ref = useRef<Ambient | null>(null);
  const [on, setOn] = useState(readPref);
  const [playing, setPlaying] = useState(false);
  const track = useTrack();
  const url = trackById(track).url;
  const onRef = useRef(on);
  onRef.current = on;
  /** 답 읽기·미리 듣기 때문에 멈춰 둔 상태. 읽기가 끝나거나 멈추면 다시 튼다(스펙 2026-10-28-012 DD10, 소리 낮추기는 하지 않는다) */
  const held = useRef(false);
  useEffect(
    () =>
      readAloud.subscribe(() => {
        const a = ref.current;
        if (!a) return;
        if (readAloud.audible()) {
          if (a.playing) {
            a.stop();
            setPlaying(false);
            held.current = true;
          }
        } else if (held.current) {
          held.current = false;
          if (onRef.current) void a.start().then(setPlaying);
        }
      }),
    []
  );
  // 곡 바꾸기를 켜기보다 먼저 둔다: 꺼진 상태에서 곡을 고르며 켜면 새 곡으로 바로 시작한다
  useEffect(() => {
    const a = ref.current;
    if (a) void a.switchTo(url).then((p) => setPlaying(a.playing && p));
  }, [url]);
  useEffect(() => {
    if (!on) return undefined;
    const a = (ref.current ??= new Ambient(url));
    const begin = () => {
      if (readAloud.audible()) {
        held.current = true; // 읽는 동안 켜면 읽기가 끝난 뒤에 튼다
        return;
      }
      void a.start().then(setPlaying);
    };
    begin();
    window.addEventListener('pointerdown', begin, { once: true });
    return () => {
      window.removeEventListener('pointerdown', begin);
      a.stop();
      setPlaying(false);
    };
    // url 은 처음 만들 때만 쓴다. 바뀐 곡은 위 효과가 switchTo 로 넘긴다
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [on]);
  const toggle = useCallback(() => {
    setOn((v) => {
      writePref(!v);
      return !v;
    });
  }, []);
  /** 곡 고르기. 오피스 하단 메뉴는 turnOn 으로 꺼져 있으면 켠다(D5) */
  const setTrack = useCallback((id: string, opts?: { turnOn?: boolean }) => {
    saveTrack(id);
    if (opts?.turnOn) {
      writePref(true);
      setOn(true);
    }
  }, []);
  return { on, playing, toggle, track, setTrack, supported: typeof Audio !== 'undefined' };
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, renderHook, waitFor } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { readAloud, resetReadAloud } from '@/components/chat/readAloudPlayer';

import { Ambient, readPref, readTrack, saveTrack, subscribeTrack, SWITCH_OUT_MS, useAmbient, VOLUME } from './ambient';
import { DEFAULT_TRACK_ID } from './audio/tracks';

function fakeAudio(blocked = false) {
  const a = {
    loop: false,
    volume: 1,
    paused: true,
    play: vi.fn(() => {
      if (blocked) return Promise.reject(new Error('NotAllowedError'));
      a.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      a.paused = true;
    }),
  };
  return a;
}

afterEach(() => {
  vi.useRealTimers();
  localStorage.clear();
});

describe('Ambient', () => {
  it('켜면 곡을 되풀이로 틀고 2초에 걸쳐 소리를 올리며, 끄면 멈춘다', async () => {
    vi.useFakeTimers();
    const audio = fakeAudio();
    const a = new Ambient('a.mp3', () => audio as unknown as HTMLAudioElement);
    expect(await a.start()).toBe(true);
    expect(audio.loop).toBe(true);
    expect(audio.volume).toBe(0);
    vi.advanceTimersByTime(2100);
    expect(audio.volume).toBeCloseTo(VOLUME);
    expect(await a.start()).toBe(true); // 두 번 켜도 다시 틀지 않는다
    expect(audio.play).toHaveBeenCalledTimes(1);
    a.stop();
    expect(audio.pause).toHaveBeenCalled();
    expect(a.playing).toBe(false);
  });

  it('브라우저가 자동 재생을 막으면 거짓을 돌려준다(다음 클릭에서 다시 튼다)', async () => {
    expect(await new Ambient('a.mp3', () => fakeAudio(true) as unknown as HTMLAudioElement).start()).toBe(false);
  });

  it('기본은 끔이고 저장한 설정을 읽는다', () => {
    expect(readPref()).toBe(false);
    localStorage.setItem('aas.office.ambient', 'on');
    expect(readPref()).toBe(true);
  });
});

describe('곡 바꾸기(스펙 2026-10-21-014)', () => {
  function maker() {
    const made: { url: string; audio: ReturnType<typeof fakeAudio> }[] = [];
    const make = (url: string) => {
      const audio = fakeAudio();
      made.push({ url, audio });
      return audio as unknown as HTMLAudioElement;
    };
    return { made, make };
  }

  it('재생 중에 바꾸면 앞 곡을 줄여 멈추고 새 곡을 0 에서 올린다', async () => {
    vi.useFakeTimers();
    const { made, make } = maker();
    const a = new Ambient('a.mp3', make);
    await a.start();
    vi.advanceTimersByTime(2100);
    expect(await a.switchTo('b.mp3')).toBe(true);
    expect(made.map((m) => m.url)).toEqual(['a.mp3', 'b.mp3']);
    const [first, second] = made.map((m) => m.audio);
    expect(second.volume).toBe(0);
    vi.advanceTimersByTime(SWITCH_OUT_MS + 100);
    expect(first.volume).toBe(0);
    expect(first.pause).toHaveBeenCalled();
    vi.advanceTimersByTime(2100);
    expect(second.volume).toBeCloseTo(VOLUME);
    expect(second.paused).toBe(false);
  });

  it('재생 중이 아니면 곡만 기억하고, 다음에 켜면 새 곡으로 튼다', async () => {
    const { made, make } = maker();
    const a = new Ambient('a.mp3', make);
    expect(await a.switchTo('b.mp3')).toBe(false);
    expect(made).toHaveLength(0);
    await a.start();
    expect(made.map((m) => m.url)).toEqual(['b.mp3']);
  });

  it('빠르게 두 번 바꾸면 마지막 곡만 남는다', async () => {
    vi.useFakeTimers();
    const { made, make } = maker();
    const a = new Ambient('a.mp3', make);
    await a.start();
    await Promise.all([a.switchTo('b.mp3'), a.switchTo('c.mp3')]);
    vi.advanceTimersByTime(SWITCH_OUT_MS + 2100);
    expect(made.filter((m) => !m.audio.paused).map((m) => m.url)).toEqual(['c.mp3']);
    a.stop();
    expect(made.every((m) => m.audio.paused)).toBe(true);
  });

  it('고른 곡은 aas.office.ambient.track 에 저장하고 구독자에게 바로 알린다', () => {
    expect(readTrack()).toBe(DEFAULT_TRACK_ID);
    const seen: string[] = [];
    const off = subscribeTrack(() => seen.push(readTrack()));
    saveTrack('carefree');
    expect(localStorage.getItem('aas.office.ambient.track')).toBe('carefree');
    expect(seen).toEqual(['carefree']);
    off();
    saveTrack('menu-music');
    expect(seen).toEqual(['carefree']);
  });

  it('다른 탭에서 바꾼 곡은 storage 이벤트로 받는다', () => {
    const seen: string[] = [];
    const off = subscribeTrack(() => seen.push(readTrack()));
    localStorage.setItem('aas.office.ambient.track', 'goldberg-aria');
    window.dispatchEvent(new StorageEvent('storage', { key: 'aas.office.ambient.track' }));
    expect(seen).toEqual(['goldberg-aria']);
    off();
  });

  it('저장된 곡이 목록에 없으면(예: 옛 곡) 기본 곡이다', () => {
    localStorage.setItem('aas.office.ambient.track', 'contemplation');
    expect(readTrack()).toBe(DEFAULT_TRACK_ID);
  });

  it('저장소가 막혀도 오류 없이 이번 화면에서 기억한다', () => {
    const set = vi.spyOn(Storage.prototype, 'setItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    const get = vi.spyOn(Storage.prototype, 'getItem').mockImplementation(() => {
      throw new Error('blocked');
    });
    expect(() => saveTrack('chill-lofi')).not.toThrow();
    expect(readTrack()).toBe('chill-lofi');
    set.mockRestore();
    get.mockRestore();
    saveTrack(DEFAULT_TRACK_ID);
  });
});

// 답 읽기·미리 듣기 동안 배경음악을 멈추고, 끝나거나 멈추면 다시 튼다. 소리 낮추기는 하지 않는다(스펙 2026-10-28-012 DD10)
describe('useAmbient 와 읽어 주기', () => {
  afterEach(() => {
    act(() => resetReadAloud());
    vi.unstubAllGlobals();
  });

  it('읽기가 시작되면 멈추고, 읽기를 멈추면 다시 튼다', async () => {
    const audios: ReturnType<typeof fakeAudio>[] = [];
    vi.stubGlobal(
      'Audio',
      // new Audio() 로 부르므로 일반 함수여야 한다(vitest 4 는 화살표 함수 대역을 new 로 부르면 오류)
      vi.fn(function () {
        const a = fakeAudio();
        audios.push(a);
        return a;
      })
    );
    localStorage.setItem('aas.office.ambient', 'on');
    resetReadAloud({
      fetch: () => new Promise<Response>(() => undefined),
      makeAudio: () => ({ src: '', onended: null, onerror: null, play: () => Promise.resolve(), pause: () => undefined }),
    });
    const { result } = renderHook(() => useAmbient());
    await waitFor(() => expect(result.current.playing).toBe(true));
    const music = audios[0];
    act(() => readAloud.press({ conv: 'c', msg: 'm', name: 'a', profile: 'main', text: '글', voice: 'v' }));
    expect(music.pause).toHaveBeenCalled();
    expect(result.current.playing).toBe(false);
    act(() => readAloud.stop());
    await waitFor(() => expect(result.current.playing).toBe(true));
  });
});

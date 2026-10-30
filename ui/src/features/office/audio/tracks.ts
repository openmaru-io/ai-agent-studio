/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 오피스 배경음악 곡 목록(스펙 2026-10-21-014). 설정 › 내 화면과 오피스 하단 메뉴가 같은 목록을 쓴다.
// 곡은 화면 묶음 안에 있고(외부 요청 없음), 브라우저는 고른 곡 하나만 받는다. 출처·라이선스: README.md
import carefree from './carefree.mp3?url';
import chillLofi from './chill-lofi.mp3?url';
import forestAmbience from './forest-ambience.mp3?url';
import goldbergAria from './goldberg-aria.mp3?url';
import menuMusic from './menu-music.mp3?url';

export type Mood = 'calm' | 'lofi' | 'upbeat' | 'nature' | 'classical';
export const MOODS: readonly Mood[] = ['calm', 'lofi', 'upbeat', 'nature', 'classical'];

export interface Track {
  /** 저장 값이라 바꾸지 않는다 */
  id: string;
  mood: Mood;
  /** 곡 이름·작곡자는 번역하지 않는다 */
  title: string;
  credit: string;
  license: 'CC0' | 'CC BY 4.0';
  url: string;
}

export const TRACKS: readonly Track[] = [
  { id: 'menu-music', mood: 'calm', title: 'Menu Music', credit: 'mrpoly', license: 'CC0', url: menuMusic },
  { id: 'chill-lofi', mood: 'lofi', title: 'Chill lofi inspired', credit: 'omfgdude, qubodup', license: 'CC0', url: chillLofi },
  { id: 'carefree', mood: 'upbeat', title: 'Carefree', credit: 'Kevin MacLeod', license: 'CC BY 4.0', url: carefree },
  { id: 'forest-ambience', mood: 'nature', title: 'Forest Ambience', credit: 'TinyWorlds', license: 'CC0', url: forestAmbience },
  { id: 'goldberg-aria', mood: 'classical', title: 'Goldberg Variations — Aria', credit: 'J. S. Bach, Kimiko Ishizaka', license: 'CC0', url: goldbergAria },
];

export const DEFAULT_TRACK_ID = 'menu-music';

/** 모르는 id(지운 곡·빈 값)는 기본 곡 */
export function trackById(id: string | null | undefined): Track {
  return TRACKS.find((x) => x.id === id) ?? TRACKS.find((x) => x.id === DEFAULT_TRACK_ID)!;
}

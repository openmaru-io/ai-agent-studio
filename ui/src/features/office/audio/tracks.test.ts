/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { DEFAULT_TRACK_ID, MOODS, trackById, TRACKS } from './tracks';

describe('배경음악 곡 목록(스펙 2026-10-21-014)', () => {
  it('분위기마다 한 곡씩 다섯 곡이고 id 가 겹치지 않는다', () => {
    expect(TRACKS).toHaveLength(5);
    expect(new Set(TRACKS.map((x) => x.id)).size).toBe(5);
    expect(MOODS.map((m) => TRACKS.filter((x) => x.mood === m).length)).toEqual([1, 1, 1, 1, 1]);
  });

  it('기본 곡은 Menu Music 이고, 모르는 id·빈 값은 기본 곡이다', () => {
    expect(trackById(DEFAULT_TRACK_ID).title).toBe('Menu Music');
    expect(trackById('contemplation').id).toBe(DEFAULT_TRACK_ID);
    expect(trackById(null).id).toBe(DEFAULT_TRACK_ID);
    expect(trackById('carefree').title).toBe('Carefree');
  });

  it('모든 곡에 작곡·연주자와 라이선스가 있다(CC BY 곡은 출처 표기가 의무)', () => {
    for (const x of TRACKS) {
      expect(x.credit).not.toBe('');
      expect(['CC0', 'CC BY 4.0']).toContain(x.license);
      expect(x.url).toMatch(/\.mp3/);
    }
    expect(trackById('carefree')).toMatchObject({ credit: 'Kevin MacLeod', license: 'CC BY 4.0' });
  });
});

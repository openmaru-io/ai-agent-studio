/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 스펙 2026-10-21-012 §3-4: 상태판에서 고른 에이전트·회의실 표시의 시간별 값
import { describe, expect, it } from 'vitest';

import { HIGHLIGHT_MS, highlightFrame, MINE_INTRO_MS, mineIntroFrame, SELECT_RING } from './selectHighlight';

describe('highlightFrame', () => {
  it('고리는 0.6초 동안 크게(0.9)에서 발밑(0.32)으로 줄고, 2.1초까지 그대로, 2.5초에 사라진다', () => {
    expect(HIGHLIGHT_MS).toBe(2500);
    expect(highlightFrame(0, false)).toMatchObject({ ringScale: 0.9 / SELECT_RING.mid, opacity: 1, done: false });
    expect(highlightFrame(600, false).ringScale).toBeCloseTo(1);
    expect(highlightFrame(2100, false)).toMatchObject({ ringScale: 1, opacity: 1 });
    expect(highlightFrame(2300, false).opacity).toBeCloseTo(0.5);
    expect(highlightFrame(2500, false)).toMatchObject({ opacity: 0, done: true });
  });

  it('줄어드는 고리는 처음에 빠르고 끝에서 느리다(카메라 이동과 같은 감속)', () => {
    const a = 0.9 / SELECT_RING.mid - highlightFrame(150, false).ringScale;
    const b = highlightFrame(450, false).ringScale - highlightFrame(600, false).ringScale;
    expect(a).toBeGreaterThan(b);
  });

  it('이름표는 0.2초에 1.25배, 0.5초에 원래 크기다', () => {
    expect(highlightFrame(0, false).labelScale).toBe(1);
    expect(highlightFrame(200, false).labelScale).toBeCloseTo(1.25);
    expect(highlightFrame(500, false).labelScale).toBeCloseTo(1);
    expect(highlightFrame(1500, false).labelScale).toBe(1);
  });

  it('회의실 테두리는 0.3초 동안 나타난다', () => {
    expect(highlightFrame(0, false).roomOpacity).toBe(0);
    expect(highlightFrame(150, false).roomOpacity).toBeCloseTo(0.5);
    expect(highlightFrame(300, false).roomOpacity).toBe(1);
    expect(highlightFrame(2500, false).roomOpacity).toBe(0);
  });

  it('줄인 움직임이면 크기가 바뀌지 않고, 바로 나타났다 2.5초에 바로 사라진다', () => {
    for (const t of [0, 200, 600, 2300, 2499]) {
      expect(highlightFrame(t, true)).toEqual({ ringScale: 1, labelScale: 1, opacity: 1, roomOpacity: 1, done: false });
    }
    expect(highlightFrame(2500, true)).toMatchObject({ opacity: 0, roomOpacity: 0, done: true });
  });
});

describe('mineIntroFrame', () => {
  it('처음 한 번 0.28 에서 0.55 까지 0.8초 동안 퍼지며 사라진다', () => {
    expect(MINE_INTRO_MS).toBe(800);
    expect(mineIntroFrame(0, false)).toMatchObject({ scale: 1, opacity: 1, done: false });
    expect(mineIntroFrame(800, false)).toMatchObject({ scale: 0.55 / 0.28, opacity: 0, done: true });
  });

  it('줄인 움직임이면 나오지 않는다', () => {
    expect(mineIntroFrame(0, true)).toMatchObject({ opacity: 0, done: true });
  });
});

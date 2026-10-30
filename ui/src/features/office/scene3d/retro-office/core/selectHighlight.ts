/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// AAS(스펙 2026-10-21-012): 내 에이전트 발밑 고리와, 상태판에서 고른 에이전트·회의실 표시의 크기·시간.
// 장면(useFrame)은 지난 시간만 넘기고 값은 여기서 정한다 — 시험이 화면 없이 시간별 값을 본다.

/** 내 에이전트 발밑 고리. 상태 고리(0.13~0.19)와 그 테두리 띠(0.11~0.21) 바깥이다 */
export const MINE_RING = { inner: 0.25, outer: 0.28 };
/** 고른 에이전트의 고리(줄어든 뒤 크기). 내 표시 고리 바깥이라 내 에이전트를 골라도 겹치지 않는다 */
export const SELECT_RING = { inner: 0.3, outer: 0.34, mid: 0.32 };
/** 고른 대상 표시가 보이는 시간 */
export const HIGHLIGHT_MS = 2500;
/** 장면에 처음 그려질 때 내 표시 고리가 한 번 퍼지는 시간 */
export const MINE_INTRO_MS = 800;

const SHRINK_MS = 600;
const SELECT_START = 0.9 / SELECT_RING.mid;
const POP_UP_MS = 200;
const POP_DOWN_MS = 300;
const POP = 1.25;
const ROOM_IN_MS = 300;
const FADE_MS = 400;
const INTRO_END = 0.55 / MINE_RING.outer;

/** 지난 시간 t(ms)의 표시 값. ringScale 은 SELECT_RING 크기에 곱한다. 줄인 움직임이면 크기가 바뀌지 않고 바로 나타났다 바로 사라진다. */
export function highlightFrame(
  t: number,
  reducedMotion: boolean,
): { ringScale: number; labelScale: number; opacity: number; roomOpacity: number; done: boolean } {
  if (t >= HIGHLIGHT_MS) return { ringScale: 1, labelScale: 1, opacity: 0, roomOpacity: 0, done: true };
  if (reducedMotion) return { ringScale: 1, labelScale: 1, opacity: 1, roomOpacity: 1, done: false };
  // 카메라 프리셋(매 프레임 남은 거리의 일부를 간다)처럼 처음에 빠르고 끝에서 느리다
  const k = Math.min(t / SHRINK_MS, 1);
  const ringScale = SELECT_START + (1 - SELECT_START) * (1 - (1 - k) ** 3);
  const labelScale =
    t <= POP_UP_MS
      ? 1 + (POP - 1) * (t / POP_UP_MS)
      : t <= POP_UP_MS + POP_DOWN_MS
        ? POP - (POP - 1) * ((t - POP_UP_MS) / POP_DOWN_MS)
        : 1;
  const fadeAt = HIGHLIGHT_MS - FADE_MS;
  const opacity = t < fadeAt ? 1 : 1 - (t - fadeAt) / FADE_MS;
  const roomOpacity = t < ROOM_IN_MS ? t / ROOM_IN_MS : opacity;
  return { ringScale, labelScale, opacity, roomOpacity, done: false };
}

/** 내 표시 고리가 처음 한 번 퍼지는 값. scale 은 MINE_RING 크기에 곱한다. 줄인 움직임이면 나오지 않는다. */
export function mineIntroFrame(t: number, reducedMotion: boolean): { scale: number; opacity: number; done: boolean } {
  if (reducedMotion) return { scale: 1, opacity: 0, done: true };
  const k = Math.min(Math.max(t, 0) / MINE_INTRO_MS, 1);
  return { scale: 1 + k * (INTRO_END - 1), opacity: 1 - k, done: k >= 1 };
}

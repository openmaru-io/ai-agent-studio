/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 표 색(OMAI-1165·1171): 표는 COP Console 처럼 페이지 배경 위에 놓이고, 고정 칸용 불투명 값은 반투명 값을 그 배경 위에 합성한 것과 같다.
import { describe, expect, it } from 'vitest';

import { contentBackground, gridTokens, tableHeaderOverlay, tableHeaderText } from './shellTokens';

const channels = (hex: string) => [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16));
const alphaOf = (rgba: string) => parseFloat(rgba.split(',')[3]);
const inkOf = (rgba: string) => rgba.match(/rgba\((\d+), (\d+), (\d+)/)!.slice(1, 4).map(Number);
/** 반투명 색(rgba)을 바탕 위에 합성한 불투명 색 */
const composite = (base: string, rgba: string) => {
  const ink = inkOf(rgba);
  return '#' + channels(base).map((c, i) => Math.round(c + (ink[i] - c) * alphaOf(rgba)).toString(16).padStart(2, '0')).join('');
};

describe('gridTokens', () => {
  it('다크의 표 바탕은 페이지 배경(#08090a)이다 — COP Console 과 같다', () => {
    expect(gridTokens.dark.surface).toBe(contentBackground.dark.default);
    expect(gridTokens.dark.surface).toBe('#08090a');
  });

  it('라이트의 표 바탕도 페이지 배경(#edeef2)이다 — COP 의 Table 은 모드와 관계없이 본문 행이 투명이다', () => {
    expect(gridTokens.light.surface).toBe(contentBackground.light.default);
    expect(gridTokens.light.surface).toBe('#edeef2');
  });

  it.each(['dark', 'light'] as const)('%s: 불투명 값은 반투명 값을 표 바탕 위에 합성한 값과 같다', (mode) => {
    const t = gridTokens[mode];
    expect(t.headSolid).toBe(composite(t.surface, t.head));
    expect(t.hoverSolid).toBe(composite(t.surface, t.hover));
    expect(t.selectedSolid).toBe(composite(t.surface, t.selected));
  });

  it.each(['dark', 'light'] as const)('%s: 헤더 줄과 헤더 글자는 COP 의 tableHeaderOverlay·tableHeaderText 와 같다', (mode) => {
    const t = gridTokens[mode];
    expect(t.head).toBe(tableHeaderOverlay[mode]);
    expect(t.headText).toBe(tableHeaderText[mode].color);
    expect(t.headHover).toBe(tableHeaderText[mode].hoverColor);
  });

  it('도구줄·푸터(bar)는 헤더 줄보다 옅다(다크)', () => {
    expect(alphaOf(gridTokens.dark.bar)).toBeLessThan(alphaOf(gridTokens.dark.head));
  });

  it('라이트 헤더 줄은 COP 가 적은 실측값 #e6e7eb 이다', () => {
    expect(gridTokens.light.headSolid).toBe('#e6e7eb');
    expect(contentBackground.light.muted).toBe('#e6e7eb');
  });
});

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { dialogTokens } from '@/lib/shellTokens';

import { makeTheme, ThemeMode } from './theme';

/** 파랑 계열인가(색상 195°~255°, 채도 있음) */
function isBlue(hex: string): boolean {
  const n = parseInt(hex.slice(1), 16);
  const [r, g, b] = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  const mx = Math.max(r, g, b);
  const mn = Math.min(r, g, b);
  if (mx - mn < 45) return false;
  const d = mx - mn;
  const h = (((mx === r ? ((g - b) / d) % 6 : mx === g ? (b - r) / d + 2 : (r - g) / d + 4) * 60) + 360) % 360;
  return h >= 195 && h <= 255;
}

describe.each<ThemeMode>(['dark', 'light'])('테마 단추·색 (%s) — DESIGN.md §4 3-Tier, §1-1 Hue Discipline', (mode) => {
  const theme = makeTheme(mode);
  const dlg = dialogTokens[mode];
  const btn = theme.components?.MuiButton?.styleOverrides as Record<string, Record<string, unknown>>;

  it('동작 색(primary)은 파랑이 아니라 모노크롬이다', () => {
    expect(isBlue(theme.palette.primary.main)).toBe(false);
    expect(theme.palette.primary.main).toBe(mode === 'dark' ? '#f7f8f8' : '#111827');
  });

  it('contained 단추는 어디에서나 Tier 1(단색 wash + 테두리 + 안쪽 빛)이고 파란 solid 가 아니다', () => {
    expect(btn.containedPrimary).toMatchObject({ color: dlg.tier1.text, backgroundColor: dlg.tier1.bg });
    expect(String(btn.containedPrimary.boxShadow)).toContain(dlg.tier1.border); // 테두리는 안쪽 그림자로 그려 단추 크기가 변하지 않는다
    expect(btn.containedPrimary['&:hover']).toMatchObject({ backgroundColor: dlg.tier1.hoverBg });
  });

  it('error contained 단추는 Tier 3(빨강 wash)이다', () => {
    expect(btn.containedError).toMatchObject({ color: dlg.tier3.text, backgroundColor: dlg.tier3.bg });
  });

  it('정보(info)는 DESIGN.md 의 Sky 다', () => {
    expect(theme.palette.info.main).toBe(mode === 'dark' ? '#60a5fa' : '#2563eb');
  });
});

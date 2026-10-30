/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { BALLOON_PALETTE, BANNER_PALETTE, HUD_PALETTE, SCENE_BACKDROP, STATUS_COLOR, statusDotColor } from './tokens';

describe('statusDotColor', () => {
  it('오류가 가장 앞서고, 일함·부재·쉼 순서로 정한다', () => {
    expect(statusDotColor({ error: true, working: true, away: false })).toBe(STATUS_COLOR.error);
    expect(statusDotColor({ error: false, working: true, away: true })).toBe(STATUS_COLOR.working);
    expect(statusDotColor({ error: false, working: false, away: true })).toBe(STATUS_COLOR.away);
    expect(statusDotColor({ error: false, working: false, away: false })).toBe(STATUS_COLOR.idle);
  });

  it('쉼에 경고 색(앰버)을 쓰지 않는다 — DESIGN.md 에서 앰버는 경고 전용이다', () => {
    expect(STATUS_COLOR.idle.toLowerCase()).not.toBe('#f59e0b');
    expect(Object.values(STATUS_COLOR).map((c) => c.toLowerCase())).not.toContain('#f59e0b');
  });
});

describe('SCENE_BACKDROP', () => {
  it('다크·라이트 모두 원본의 갈색(#1a1008)이 아니다', () => {
    for (const v of Object.values(SCENE_BACKDROP)) expect(v.toLowerCase()).not.toContain('#1a1008');
  });

  it('가장자리는 콘솔 본문 배경에 이어진다', () => {
    expect(SCENE_BACKDROP.dark).toContain('#08090a');
    expect(SCENE_BACKDROP.light).toContain('#dcdfe8');
  });
});

// WCAG 상대 휘도·대비. 현수막 글자가 천 위에서 읽혀야 한다.
const lum = (hex: string) => {
  const [r, g, b] = [1, 3, 5].map((i) => parseInt(hex.slice(i, i + 2), 16) / 255).map((c) => (c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4));
  return 0.2126 * r + 0.7152 * g + 0.0722 * b;
};
const contrast = (a: string, b: string) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe('BANNER_PALETTE (현수막은 DESIGN.md 모노크롬 + 브랜드 레드, 크림·청록을 쓰지 않는다)', () => {
  for (const mode of ['dark', 'light'] as const) {
    const p = BANNER_PALETTE[mode];
    it(`${mode}: 문구는 천 위에서 7:1 이상, 부서 이름(브랜드 레드)은 4.5:1 이상 읽힌다`, () => {
      expect(contrast(p.text, p.clothA)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.text, p.clothB)).toBeGreaterThanOrEqual(7);
      expect(contrast(p.team, p.clothA)).toBeGreaterThanOrEqual(4.5);
      expect(contrast(p.team, p.clothB)).toBeGreaterThanOrEqual(4.5);
    });
    it(`${mode}: 천은 크림색(#f8f2e3 계열)이 아니다`, () => {
      for (const c of [p.clothA, p.clothB]) expect(['#f8f2e3', '#eee4cb']).not.toContain(c.toLowerCase());
    });
  }
  it('다크에서는 어두운 천, 라이트에서는 밝은 천이다(장면 배경과 같은 방향)', () => {
    expect(lum(BANNER_PALETTE.dark.clothA)).toBeLessThan(0.05);
    expect(lum(BANNER_PALETTE.light.clothA)).toBeGreaterThan(0.85);
  });
});

describe('BALLOON_PALETTE', () => {
  it('열기구 몸통은 브랜드 레드(#DA291C)이고 청록을 쓰지 않는다', () => {
    expect(BALLOON_PALETTE.envelope.toLowerCase()).toBe('#da291c');
    expect(Object.values(BALLOON_PALETTE).map((c) => c.toLowerCase())).not.toContain('#4c889c');
  });
});

// 상태판 흐린 글자(둘째 줄·빈 안내 등 11~12px)의 라이트 대비. #6b7280 은 #f5f6f9 위 4.47:1 이라 AA(4.5:1)에 못 미쳤다
// (스펙 2026-10-20-021 DR17·G1, 같은 계산은 lib/chatTokens.test.ts).
describe('HUD_PALETTE 흐린 글자 대비', () => {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  const lum = (h: string) => {
    const v = h.replace('#', '');
    const [r, g, b] = [0, 2, 4].map((i) => lin(parseInt(v.slice(i, i + 2), 16)));
    return 0.2126 * r + 0.7152 * g + 0.0722 * b;
  };
  const ratio = (a: string, b: string) => {
    const [x, y] = [lum(a), lum(b)].sort((m, n) => n - m);
    return (x + 0.05) / (y + 0.05);
  };

  it('라이트·다크 모두 fg3 가 패널 바탕 위 4.5:1 이상이다', () => {
    expect(ratio(HUD_PALETTE.light.fg3, HUD_PALETTE.light.solid)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(HUD_PALETTE.dark.fg3, HUD_PALETTE.dark.solid)).toBeGreaterThanOrEqual(4.5);
  });

  it('처음 값 #6b7280 은 라이트 패널 위에서 4.5:1 에 못 미친다(다시 쓰지 않는다)', () => {
    expect(HUD_PALETTE.light.fg3).not.toBe('#6b7280');
    expect(ratio('#6b7280', HUD_PALETTE.light.solid)).toBeLessThan(4.5);
  });
});

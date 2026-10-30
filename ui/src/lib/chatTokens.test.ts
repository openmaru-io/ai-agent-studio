/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { ACTOR_HUES } from '@/components/UserChip';

import { AVATAR_HUES, avatarTile, chatColumn, chatColumnPad, chatMetrics, chatTokens } from './chatTokens';
import { contentBackground, dialogTokens } from './shellTokens';

type RGB = [number, number, number];
const hex = (h: string): RGB => {
  const v = h.replace('#', '');
  return [0, 2, 4].map((i) => parseInt(v.slice(i, i + 2), 16)) as RGB;
};
const rgba = (c: string): { rgb: RGB; a: number } => {
  if (c.startsWith('#')) return { rgb: hex(c), a: 1 };
  const m = /rgba?\(([^)]+)\)/.exec(c);
  const p = (m?.[1] ?? '').split(',').map((x) => parseFloat(x));
  return { rgb: [p[0], p[1], p[2]], a: p[3] ?? 1 };
};
/** over 위에 c 를 얹은 색 */
const over = (c: string, base: RGB): RGB => {
  const { rgb, a } = rgba(c);
  return [0, 1, 2].map((i) => rgb[i] * a + base[i] * (1 - a)) as RGB;
};
const lin = (v: number) => {
  const c = v / 255;
  return c <= 0.03928 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
};
const lum = (c: RGB) => 0.2126 * lin(c[0]) + 0.7152 * lin(c[1]) + 0.0722 * lin(c[2]);
const ratio = (a: RGB, b: RGB) => {
  const [hi, lo] = [lum(a), lum(b)].sort((x, y) => y - x);
  return (hi + 0.05) / (lo + 0.05);
};

describe.each(['dark', 'light'] as const)('chatTokens %s 글자 대비(WCAG AA 4.5:1)', (mode) => {
  const tk = chatTokens[mode];
  const canvas = hex(tk.canvas);
  const surfaces: [string, RGB][] = [
    ['바탕', canvas],
    ['내 말 판', over(tk.mine, canvas)],
    ['목록 바탕', over(tk.rail, canvas)],
    ['입력 카드', over(tk.composer, canvas)],
    ['단색 아바타 타일', over(tk.monoTile, canvas)],
    ['선택 행', over(tk.selected, canvas)],
    ['움푹한 칸(승인 카드 명령)', over(tk.sunken, canvas)],
  ];
  it.each(surfaces)('본문 글자가 %s 위에서 4.5:1 이상', (_n, bg) => {
    expect(ratio(hex(tk.text), bg)).toBeGreaterThanOrEqual(4.5);
  });
  it.each(surfaces)('보조 글자(11px 시각·안내)가 %s 위에서 4.5:1 이상', (_n, bg) => {
    expect(ratio(hex(tk.muted), bg)).toBeGreaterThanOrEqual(4.5);
  });
});

// 파일 뱃지의 「회의」 표지(스펙 2026-10-20-002 DD13): Subtle Badge 바탕(0.05) 위 보조 글자가 내 말 판·답 바탕에서도 읽힌다
describe.each(['dark', 'light'] as const)('「회의」 표지 %s 대비', (mode) => {
  const tk = chatTokens[mode];
  const canvas = hex(tk.canvas);
  const badge = mode === 'dark' ? 'rgba(255,255,255,0.05)' : 'rgba(17,24,39,0.05)';
  it.each([
    ['내 말 판', over(tk.mine, canvas)],
    ['답 바탕', canvas],
  ] as [string, RGB][])('%s 위 표지 글자 4.5:1 이상', (_n, bg) => {
    expect(ratio(hex(tk.muted), over(badge, bg))).toBeGreaterThanOrEqual(4.5);
  });
});

describe('chatTokens 회귀', () => {
  it('라이트 보조 글자는 처음 값 #6b7280(4.17:1)이 아니다', () => {
    expect(chatTokens.light.muted).not.toBe('#6b7280');
    expect(ratio(hex('#6b7280'), hex(chatTokens.light.canvas))).toBeLessThan(4.5);
  });
  it('입력 카드 포커스 테두리는 공통 표 검색 입력 포커스(0.30·0.35)와 같다', () => {
    expect(chatTokens.dark.composerFocus).toBe('rgba(255, 255, 255, 0.30)');
    expect(chatTokens.light.composerFocus).toBe('rgba(17, 24, 39, 0.35)');
  });
});

describe.each(['dark', 'light'] as const)('색조 아바타 타일 %s', (mode) => {
  // 변경 기록 「누가」의 주체 칩(AAS 자동·에이전트·로그인 전)도 같은 타일을 쓴다. 사람 칩 색과 겹치지 않는다
  it.each([...AVATAR_HUES, ...Object.values(ACTOR_HUES)])('%s 타일의 글자가 바탕 위에서 4.5:1 이상', (color) => {
    const { bg, fg } = avatarTile(color, mode);
    const surface = over(bg, hex(chatTokens[mode].canvas));
    expect(ratio(rgba(fg).rgb, surface)).toBeGreaterThanOrEqual(4.5);
  });
});

it('주체 칩 색은 사람 칩 팔레트에 없다', () => {
  for (const c of Object.values(ACTOR_HUES)) expect(AVATAR_HUES as readonly string[]).not.toContain(c);
});

describe('본문 열 폭(chatColumn)', () => {
  // 좁은 화면은 720px(14px 한글 한 줄 약 48자) 그대로, 넓은 화면은 화면 폭의 56% 로 넓혀 960px 에서 멈춘다
  const px = (vw: number) => {
    const m = /^clamp\((\d+)px, (\d+)vw, (\d+)px\)$/.exec(chatColumn);
    expect(m).not.toBeNull();
    const [min, rate, max] = [Number(m![1]), Number(m![2]), Number(m![3])];
    return Math.min(Math.max(min, (vw * rate) / 100), max);
  };
  it('최소는 옛 값 720px 이고 최대는 960px 이다', () => {
    expect(chatMetrics.column).toBe(720);
    expect(chatMetrics.columnMax).toBe(960);
  });
  it('1280 이하에서는 720px, 1600 에서는 896px, 1920 이상에서는 960px', () => {
    expect(px(1024)).toBe(720);
    expect(px(1280)).toBe(720);
    expect(px(1600)).toBe(896);
    expect(px(1920)).toBe(960);
    expect(px(2560)).toBe(960);
  });
  it('카드 줄 폭은 열 폭에 좌우 여백 32px 을 더한다', () => {
    expect(chatColumnPad).toBe(`calc(${chatColumn} + 32px)`);
  });
});

describe.each(['dark', 'light'] as const)('떠 있는 대화 창 토큰 %s (OMAI-1265)', (mode) => {
  const tk = chatTokens[mode];
  const pop = tk.popup;
  const surface = hex(pop.surface);
  it('창 면이 서랍 면·페이지 바탕과 달라 겹쳐도 구분된다(전에는 서랍과 같은 #191a1b 였다)', () => {
    expect(pop.surface.toLowerCase()).not.toBe(dialogTokens[mode].surface.toLowerCase());
    expect(pop.surface.toLowerCase()).not.toBe(contentBackground[mode].default.toLowerCase());
    // 면 자체의 밝기 차이(다크는 한 단계 위, 라이트는 가장 밝은 흰색)
    expect(ratio(surface, hex(dialogTokens[mode].surface))).toBeGreaterThanOrEqual(mode === 'dark' ? 1.08 : 1.02);
  });
  it('테두리는 서랍 가장자리 선(0.08/0.10)보다 또렷하고, 앞에 있는 창의 테두리가 더 또렷하다', () => {
    const alpha = (c: string) => rgba(c).a;
    expect(alpha(pop.edge)).toBeGreaterThan(alpha(dialogTokens[mode].edge));
    expect(alpha(pop.edgeFront)).toBeGreaterThan(alpha(pop.edge));
  });
  it('그림자는 겹침 둘 이상이고 외곽 1px 링을 가진다', () => {
    expect(pop.shadow.split('),').length).toBeGreaterThanOrEqual(3);
    expect(pop.shadow).toMatch(/^0 0 0 1px /);
  });
  it('본문·보조 글자가 창 면 위에서 4.5:1 이상', () => {
    expect(ratio(hex(tk.text), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(tk.muted), surface)).toBeGreaterThanOrEqual(4.5);
    expect(ratio(hex(tk.text), over(tk.mine, surface))).toBeGreaterThanOrEqual(4.5);
  });
});

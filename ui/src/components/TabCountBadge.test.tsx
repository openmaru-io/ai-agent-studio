/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { createTheme, ThemeProvider } from '@mui/material';
import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TabCountBadge } from '@/components/TabCountBadge';

// jsdom 은 CSS 우선순위를 가리지 못해 계산된 색으로는 판단할 수 없다. 배지에 붙은 sx 규칙(`.css-x .MuiBadge-badge`, 클래스 2개라 MUI 의
// `.MuiBadge-colorWarning` 보다 우선한다)이 흰색을 지정하는지 본다.
const badgeColor = (mode: 'light' | 'dark', tone: 'bad' | 'warn' | 'good') => {
  const { container } = render(
    <ThemeProvider theme={createTheme({ palette: { mode } })}>
      <TabCountBadge count={2} tone={tone}>
        탭
      </TabCountBadge>
    </ThemeProvider>,
  );
  const root = container.querySelector('.MuiBadge-root') as HTMLElement;
  const emotion = [...root.classList].find((c) => c.startsWith('css-')) as string;
  const rules = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => r.cssText.includes(`.${emotion} .MuiBadge-badge`));
  return rules.map((r) => (r as CSSStyleRule).style.color).find(Boolean);
};

// 배지 위치: 36px 탭은 MUI Tab 자신이 넘침을 잘라 배지 윗면이 잘린다. 기준 자리(anchorOriginTopRight)는 두고 덜 올린다(스펙 2026-10-19-005 R2)
const badgeTransform = () => {
  const { container } = render(
    <ThemeProvider theme={createTheme()}>
      <TabCountBadge count={12}>탭</TabCountBadge>
    </ThemeProvider>,
  );
  const root = container.querySelector('.MuiBadge-root') as HTMLElement;
  expect(root.querySelector('.MuiBadge-anchorOriginTopRight')).not.toBeNull();
  const emotion = [...root.classList].find((c) => c.startsWith('css-')) as string;
  const rules = [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => r.cssText.includes(`.${emotion} .MuiBadge-anchorOriginTopRight`));
  return rules.map((r) => (r as CSSStyleRule).style.transform).find(Boolean);
};

describe('TabCountBadge', () => {
  it('배지는 오른쪽 위 모서리에 두되 배지 높이의 30% 만 올린다(36px 탭에서 잘리지 않게)', () => {
    expect(badgeTransform()).toBe('scale(1) translate(50%, -30%)');
  });

  it('색이 있는 배지(주황·빨강·초록)의 숫자는 라이트 모드에서 흰색이다', () => {
    for (const tone of ['warn', 'bad', 'good'] as const) expect(badgeColor('light', tone)).toBe('#fff');
  });

  it('주황·초록 배지의 숫자는 다크 모드에서 검은색이다', () => {
    for (const tone of ['warn', 'good'] as const) expect(badgeColor('dark', tone)).toBe('#08090a');
  });

  it('빨간 배지의 숫자는 다크 모드에서도 흰색이다(OMAI-1247)', () => {
    expect(badgeColor('dark', 'bad')).toBe('#fff');
  });
});

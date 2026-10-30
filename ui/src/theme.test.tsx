/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Tab, Tabs } from '@mui/material';
import { ThemeProvider } from '@mui/material/styles';
import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { makeTheme } from './theme';

// 켠 탭은 단색(DESIGN.md §1-1.2 「Tab active」, 「Tabs — Bordered Tabs」). theme primary 파랑(#1565C0)이 쓰이면 안 된다(OMAI-1127).
const mount = (mode: 'dark' | 'light') =>
  render(
    <ThemeProvider theme={makeTheme(mode)}>
      <Tabs value="a" aria-label="시험 탭">
        <Tab value="a" label="켠 탭" />
        <Tab value="b" label="꺼진 탭" />
      </Tabs>
    </ThemeProvider>
  );

describe('탭 줄(theme)', () => {
  it.each([
    ['dark', 'rgb(247, 248, 248)', 'rgb(138, 143, 152)', 'rgba(255, 255, 255, 0.85)'],
    ['light', 'rgb(17, 24, 39)', 'rgb(107, 114, 128)', 'rgba(17, 24, 39, 0.7)'],
  ] as const)('%s: 켠 탭은 primary 글자·600·단색 밑줄, 꺼진 탭은 회색', (mode, on, off, line) => {
    const { container } = mount(mode);
    const active = screen.getByRole('tab', { name: '켠 탭' });
    const idle = screen.getByRole('tab', { name: '꺼진 탭' });
    expect(getComputedStyle(active).color).toBe(on);
    expect(getComputedStyle(active).fontWeight).toBe('600');
    expect(getComputedStyle(idle).color).toBe(off);
    const bar = container.querySelector('.MuiTabs-indicator') as HTMLElement;
    expect(getComputedStyle(bar).backgroundColor).toBe(line);
    for (const el of [active, idle, bar]) {
      const cs = getComputedStyle(el);
      expect([cs.color, cs.backgroundColor].join(' ')).not.toContain('21, 101, 192');
    }
  });
});

// 탭·토글 높이(스펙 2026-10-19-005 R1·R3·G4·G9). jsdom 은 @media 를 계산하지 않아 손가락 화면 값은 테마 객체로 본다
describe('탭·토글 높이(theme)', () => {
  it('탭은 36px 로 그려진다(MUI 기본 48 이 아니다)', () => {
    mount('dark');
    expect(getComputedStyle(screen.getByRole('tab', { name: '켠 탭' })).minHeight).toBe('36px');
    expect(getComputedStyle(screen.getByRole('tablist').closest('.MuiTabs-root') as HTMLElement).minHeight).toBe('36px');
  });

  it('손가락으로 누르는 화면에서만 탭·토글이 44px 이다', () => {
    const c = makeTheme('dark').components!;
    const coarse = { '@media (pointer: coarse)': { minHeight: 44 } };
    expect(c.MuiTab!.styleOverrides!.root).toMatchObject(coarse);
    expect(c.MuiTabs!.styleOverrides!.root).toMatchObject(coarse);
    expect(c.MuiToggleButton!.styleOverrides!.root).toMatchObject(coarse);
  });

  it('토글은 여백 4px 12px·최소 높이 없음, 키보드 포커스는 안쪽 링(무채색 토큰)이다', () => {
    const root = makeTheme('light').components!.MuiToggleButton!.styleOverrides!.root as Record<string, unknown>;
    expect(root.padding).toBe('4px 12px');
    expect(root.minHeight).toBeUndefined();
    expect(root['&.Mui-focusVisible']).toEqual({ boxShadow: 'inset 0 0 0 2px #111827' });
  });
});

// 포커스 링은 빨강이 아니라 무채색이다 — 어두운 화면은 본문 글자색, 밝은 화면은 진한 글자색(2026-10-19-014)
describe('포커스 링 토큰(theme)', () => {
  it.each([
    ['dark', '#f7f8f8'],
    ['light', '#111827'],
  ] as const)('%s: CSS 변수 --aas-focus-ring 과 테마의 키보드 포커스 규칙이 같은 색이다', (mode, color) => {
    const c = makeTheme(mode).components!;
    const base = c.MuiCssBaseline!.styleOverrides as Record<string, Record<string, string>>;
    expect(base[':root']['--aas-focus-ring']).toBe(color);
    const btn = c.MuiButton!.styleOverrides!.containedPrimary as Record<string, unknown>;
    expect(btn['&.Mui-focusVisible']).toEqual({ boxShadow: `0 0 0 2px ${color}` });
    const tab = c.MuiTab!.styleOverrides!.root as Record<string, unknown>;
    expect(tab['&.Mui-focusVisible']).toEqual({ boxShadow: `inset 0 0 0 2px ${color}` });
    expect(JSON.stringify(c)).not.toMatch(/2px #DA291C/i);
  });
});

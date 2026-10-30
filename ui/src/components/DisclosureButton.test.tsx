/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { Button, createTheme, ThemeProvider } from '@mui/material';
import { render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { createRef } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { DisclosureButton, pressedSx } from './DisclosureButton';

const mount = (ui: React.ReactElement) => render(<ThemeProvider theme={createTheme()}>{ui}</ThemeProvider>);

// jsdom 은 CSS 우선순위·@media 를 계산하지 않는다. 단추 클래스의 규칙을 순서대로 읽어 본다(TabCountBadge.test.tsx 방식)
const rulesOf = (el: HTMLElement) => {
  const cls = [...el.classList].filter((c) => c.startsWith('css-'));
  return [...document.styleSheets].flatMap((sh) => [...sh.cssRules]).filter((r) => cls.some((c) => r.cssText.includes(`.${c}`)));
};

describe('DisclosureButton(스펙 2026-10-19-005)', () => {
  it('펼침 상태와 펼쳐지는 영역을 알리고, 누르면 onToggle 을 부른다', async () => {
    const onToggle = vi.fn();
    mount(<DisclosureButton open={false} onToggle={onToggle} label="더 자세히 적기" controls="more-1" />);
    const btn = screen.getByRole('button', { name: '더 자세히 적기' });
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'more-1');
    await userEvent.click(btn);
    expect(onToggle).toHaveBeenCalledTimes(1);
  });

  it('펼침 아이콘은 글자 앞에 있고 펼치면 180° 돈다. 동작 줄이기에서도 돌고 전환만 끈다(G3)', () => {
    const { rerender } = mount(<DisclosureButton open={false} onToggle={() => {}} label="보기" controls="x" />);
    const icon = () => screen.getByRole('button').querySelector('.MuiButton-startIcon svg') as SVGElement;
    expect(icon()).not.toBeNull();
    expect(screen.getByRole('button').querySelector('.MuiButton-endIcon')).toBeNull();
    expect(getComputedStyle(icon()).transform).toBe('none');
    rerender(
      <ThemeProvider theme={createTheme()}>
        <DisclosureButton open onToggle={() => {}} label="접기" controls="x" />
      </ThemeProvider>
    );
    expect(getComputedStyle(icon()).transform).toBe('rotate(180deg)');
    const media = rulesOf(icon() as unknown as HTMLElement).map((r) => r.cssText).join('\n');
    expect(media).toMatch(/prefers-reduced-motion: reduce[^}]*transition: none/);
    expect(media).not.toMatch(/prefers-reduced-motion[^}]*transform/);
  });

  it('만들기 모양(look=create)은 다른 만들기 단추처럼 테두리 단추에 + 아이콘, 펼치면 아이콘을 빼고 펼침 상태는 그대로 알린다(2026-10-17-019 §5)', () => {
    const { rerender } = mount(<DisclosureButton look="create" open={false} onToggle={() => {}} label="새 예약 작업" controls="new-1" />);
    let btn = screen.getByRole('button', { name: '새 예약 작업' });
    expect(btn).toHaveClass('MuiButton-outlined');
    expect(btn.querySelector('[data-testid="AddIcon"]')).not.toBeNull();
    expect(btn.querySelector('[data-testid="ExpandMoreIcon"]')).toBeNull();
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    rerender(
      <ThemeProvider theme={createTheme()}>
        <DisclosureButton look="create" open onToggle={() => {}} label="새 예약 작업 접기" controls="new-1" />
      </ThemeProvider>
    );
    btn = screen.getByRole('button', { name: '새 예약 작업 접기' });
    expect(btn).toHaveClass('MuiButton-outlined');
    expect(btn.querySelector('svg')).toBeNull();
    expect(btn).toHaveAttribute('aria-expanded', 'true');
  });

  it('호출처가 aria-expanded·aria-controls 를 넘겨도 부품 값이 이긴다', () => {
    const rogue = { 'aria-expanded': true, 'aria-controls': 'other' } as unknown as Record<string, never>;
    mount(<DisclosureButton open={false} onToggle={() => {}} label="보기" controls="mine" {...rogue} />);
    const btn = screen.getByRole('button');
    expect(btn).toHaveAttribute('aria-expanded', 'false');
    expect(btn).toHaveAttribute('aria-controls', 'mine');
  });

  it('aria-label·color·disabled 는 넘기고 ref 로 포커스를 줄 수 있다', () => {
    const ref = createRef<HTMLButtonElement>();
    mount(<DisclosureButton ref={ref} open={false} onToggle={() => {}} label="보기" controls="x" aria-label="원본 보기" color="primary" disabled />);
    const btn = screen.getByRole('button', { name: '원본 보기' });
    expect(btn).toBeDisabled();
    expect(btn.className).toMatch(/MuiButton-colorPrimary/);
    expect(ref.current).toBe(btn);
  });

  // emotion 은 @media 블록을 기본 규칙 뒤에 쓴다. 그래서 호출처가 minHeight 를 넘겨도 손가락 화면 44 가 이긴다(sx 배열 순서와 무관, 2026-10-19 확인)
  it('키보드 포커스는 포커스 링 토큰이고, 손가락 화면 44 가 호출처 minHeight 보다 뒤에 와서 이긴다(G4·G11)', () => {
    mount(<DisclosureButton open={false} onToggle={() => {}} label="보기" controls="x" sx={{ minHeight: 36 }} />);
    const css = rulesOf(screen.getByRole('button'))
      .map((r) => r.cssText)
      .join('\n');
    expect(css).toMatch(/Mui-focusVisible[^}]*box-shadow: 0 0 0 2px var\(--aas-focus-ring\)/);
    const caller = css.indexOf('min-height: 36px');
    const coarse = css.indexOf('pointer: coarse');
    expect(caller).toBeGreaterThan(-1);
    expect(coarse).toBeGreaterThan(caller);
    expect(css.slice(coarse)).toMatch(/min-height: 44px/);
  });
});

// 켜고 끄는 글자 단추(「내용 보기」·「미리 보기」)의 켜진 모양(G5): DESIGN.md Icon Button Active 무채색 wash
describe('pressedSx', () => {
  it.each([
    ['dark', 'rgba(255,255,255,0.06)'],
    ['light', 'rgba(17,24,39,0.04)'],
  ] as const)('%s: aria-pressed="true" 이면 바탕이 %s 이다', (mode, bg) => {
    render(
      <ThemeProvider theme={createTheme({ palette: { mode } })}>
        <Button aria-pressed sx={pressedSx}>
          미리 보기
        </Button>
      </ThemeProvider>
    );
    const css = rulesOf(screen.getByRole('button')).map((r) => r.cssText).join('\n');
    expect(css.replace(/\s/g, '')).toContain(`[aria-pressed="true"]{background-color:${bg}`);
  });
});

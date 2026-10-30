/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render, screen } from '@testing-library/react';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { fillHeight, useFillHeight } from './useFillHeight';

function Probe() {
  const fill = useFillHeight<HTMLDivElement>();
  return (
    <main style={{ paddingBottom: '20px' }}>
      <div ref={fill.ref} data-testid="probe" style={{ height: fill.height }} />
    </main>
  );
}

describe('useFillHeight', () => {
  afterEach(() => vi.restoreAllMocks());

  it('위쪽 끝에서 화면 아래까지, 본문 아래 여백을 빼고 잰다', () => {
    const main = document.createElement('main');
    main.style.paddingBottom = '20px';
    const el = document.createElement('div');
    main.appendChild(el);
    document.body.appendChild(main);
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 150 } as DOMRect);
    expect(fillHeight(el, 900)).toBe(730);
    // 본문이 스크롤돼 위로 올라가 보여도 같은 높이
    Object.defineProperty(main, 'scrollTop', { value: 100, configurable: true });
    vi.spyOn(el, 'getBoundingClientRect').mockReturnValue({ top: 50 } as DOMRect);
    expect(fillHeight(el, 900)).toBe(730);
    main.remove();
  });

  it('붙인 요소에 높이를 주고 창 크기가 바뀌면 다시 잰다', () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({ top: 200 } as DOMRect);
    render(<Probe />);
    const probe = screen.getByTestId('probe');
    expect(probe.style.height).toBe(`${window.innerHeight - 220}px`);
    vi.spyOn(window, 'innerHeight', 'get').mockReturnValue(1000);
    act(() => {
      window.dispatchEvent(new Event('resize'));
    });
    expect(probe.style.height).toBe('780px');
  });
});

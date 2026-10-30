/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { TypingDots } from './TypingDots';

describe('TypingDots', () => {
  it('글자가 이름이고 점 셋은 읽지 않는다', () => {
    const { container } = render(<TypingDots label="sa 가 답하는 중…" />);
    expect(screen.getByText('sa 가 답하는 중…')).toBeInTheDocument();
    const dots = container.querySelector('[aria-hidden="true"]') as HTMLElement;
    expect(dots.children).toHaveLength(3);
  });
});

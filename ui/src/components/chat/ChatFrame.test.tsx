/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { ChatFrame } from './ChatFrame';

describe('ChatFrame', () => {
  it('12px 모서리·1px 테두리 틀이고 자식을 담는다', () => {
    render(
      <ChatFrame offset="168px">
        <span>안</span>
      </ChatFrame>
    );
    const frame = screen.getByText('안').parentElement as HTMLElement;
    const cs = getComputedStyle(frame);
    expect(cs.borderRadius).toBe('12px');
    expect(cs.borderWidth).toBe('1px');
    expect(cs.overflow).toBe('hidden');
  });
});

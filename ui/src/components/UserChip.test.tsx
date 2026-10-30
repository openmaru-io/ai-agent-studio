/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { hueOf } from '@/lib/chatTokens';

import { UserChip } from './UserChip';

describe('UserChip', () => {
  it('이름을 한 글자열 한 노드로 그리고 첫 글자를 원 안에 보인다', () => {
    render(<UserChip name="김철수" />);
    expect(screen.getByText('김철수')).toBeInTheDocument();
    expect(screen.getByText('김')).toBeInTheDocument();
  });

  it('이름이 없으면 이메일 글자를 보이고 이메일은 툴팁에 둔다', () => {
    render(<UserChip email="kim@x.com" />);
    const el = screen.getByText('kim@x.com').closest('[data-user-chip]')!;
    expect(el).toHaveAttribute('title', 'kim@x.com');
    expect(screen.getByText('K')).toBeInTheDocument();
  });

  it('이름과 이메일이 같이 오면 이름을 보이고 이메일을 툴팁에 둔다', () => {
    render(<UserChip name="김철수" email="kim@x.com" />);
    expect(screen.getByText('김철수').closest('[data-user-chip]')).toHaveAttribute('title', 'kim@x.com');
    expect(screen.queryByText('kim@x.com')).not.toBeInTheDocument();
  });

  it('원 모양에 에이전트 칩과 달리 테두리가 없다', () => {
    render(<UserChip name="lee" />);
    const chip = screen.getByText('lee').closest('[data-user-chip]') as HTMLElement;
    expect(chip).not.toHaveStyle({ borderWidth: '1px' });
    expect(screen.getByText('L')).toHaveStyle({ borderRadius: '50%' });
  });

  it('색은 이메일이 있으면 이메일로, 없으면 이름으로 정해 같은 사람은 늘 같은 색이다', () => {
    render(
      <>
        <UserChip name="김철수" email="kim@x.com" />
        <UserChip email="kim@x.com" />
      </>
    );
    const [a, b] = ['김', 'K'].map((l) => screen.getByText(l) as HTMLElement);
    expect(hueOf('kim@x.com')).toMatch(/^#/);
    expect(getComputedStyle(a).backgroundColor).toBe(getComputedStyle(b).backgroundColor);
  });
});

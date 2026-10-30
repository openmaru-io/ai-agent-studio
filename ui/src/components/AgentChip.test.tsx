/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render, screen } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import { AVATAR_HUES, hueOf } from '@/lib/chatTokens';

import { AgentChip, AgentChips, ProfileChip } from './AgentChip';

const dotOf = (el: HTMLElement) => el.closest('[data-agent-chip]')!.querySelector('[aria-hidden="true"]') as HTMLElement;

describe('AgentChip', () => {
  it('이름을 한 글자열 한 노드로 그려 글자로 찾을 수 있다', () => {
    render(<AgentChip name="aas-e2e-test" />);
    expect(screen.getByText('aas-e2e-test')).toBeInTheDocument();
  });

  it('점 색은 이름으로 정해져 같은 이름은 같은 색이고 팔레트 안의 색이다', () => {
    render(
      <>
        <AgentChip name="ma" />
        <AgentChip name="ma" size="sm" />
      </>
    );
    const [a, b] = screen.getAllByText('ma');
    expect(dotOf(a)).toHaveStyle({ backgroundColor: hueOf('ma') });
    expect(dotOf(b)).toHaveStyle({ backgroundColor: hueOf('ma') });
    expect(AVATAR_HUES).toContain(hueOf('ma'));
  });

  it('프로파일 칩은 같은 점 색에 모서리가 4px 인 사각이고 에이전트 칩은 알약이다', () => {
    render(
      <>
        <AgentChip name="ma" />
        <ProfileChip name="ma" />
      </>
    );
    const [agent, profile] = screen.getAllByText('ma').map((e) => e.closest('[data-agent-chip]') as HTMLElement);
    expect(agent).not.toHaveAttribute('data-agent-chip', 'profile');
    expect(agent).not.toHaveStyle({ borderRadius: '4px' });
    expect(profile).toHaveStyle({ borderRadius: '4px' });
    expect(profile).toHaveAttribute('data-agent-chip', 'profile');
    expect(profile.querySelector('[aria-hidden="true"]')).toHaveStyle({ backgroundColor: hueOf('ma') });
  });

  it('dim 이면 흐리게 보인다', () => {
    render(<AgentChip name="ops" dim />);
    expect(screen.getByText('ops').closest('[data-agent-chip]')).toHaveStyle({ opacity: '0.45' });
  });
});

describe('AgentChips', () => {
  const chipsOf = (el: HTMLElement) => Array.from(el.querySelectorAll('[data-agent-chip]')) as HTMLElement[];

  it('옵션 없이 부르면 지금처럼 알약 칩 4개까지 줄바꿈하고 나머지는 「+N」 풍선말이다(2026-10-19-006 DD9 회귀)', () => {
    const { container } = render(<AgentChips names={['a', 'b', 'c', 'd', 'e', 'f']} />);
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveStyle({ flexWrap: 'wrap' });
    expect(chipsOf(box).map((c) => c.getAttribute('data-agent-chip'))).toEqual(['', '', '', '']);
    expect(screen.getByText('+2')).toHaveAttribute('title', 'e, f');
  });

  it('프로파일 칸: 네모 칩 3개를 한 줄에, 맨 앞 표시와 「+N」 낭독용 글(2026-10-19-006 DD9·DD10)', () => {
    const { container } = render(
      <AgentChips
        names={['main', 'ops', 'research', 'writer', 'reviewer']}
        shape="square"
        nowrap
        max={3}
        lead={<span data-testid="lead">★</span>}
        moreLabel={(rest) => `${rest.length}개 더: ${rest.join(', ')}`}
      />
    );
    const box = container.firstElementChild as HTMLElement;
    expect(box).toHaveStyle({ flexWrap: 'nowrap' });
    expect(chipsOf(box).map((c) => c.getAttribute('data-agent-chip'))).toEqual(['profile', 'profile', 'profile']);
    expect(box.textContent?.indexOf('★')).toBe(0); // 맨 앞 표시는 첫 칩 앞
    expect(screen.getByText('+2')).toHaveAttribute('aria-hidden', 'true');
    const slots = Array.from(box.querySelectorAll('[data-chip-slot]')) as HTMLElement[];
    expect(slots.map((e) => e.style.flex || getComputedStyle(e).flex)).toEqual(['0 0 auto', '0 0 auto', '0 1 auto']); // 짧은 이름은 줄지 않고 긴 이름만 말줄임
    expect(screen.getByText('2개 더: writer, reviewer')).toBeInTheDocument(); // 낭독기만 읽는 글
  });
});

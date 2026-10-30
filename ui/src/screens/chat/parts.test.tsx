/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { render } from '@testing-library/react';
import { describe, expect, it } from 'vitest';

import type { Item } from '@/lib/chat';

import { Steps } from './parts';

const head = (items: Item[]) =>
  render(<Steps items={items} live open={false} onToggle={() => {}} />).container.querySelector('summary')?.textContent;

describe('Steps 머리줄(진행 중)', () => {
  it('도는 도구는 이름과 맥락을 보인다', () => {
    expect(head([{ kind: 'tool', name: 'web_search', context: 'q', state: 'running' }])).toBe('web_search q');
  });

  it('도구가 끝나고 다음 답을 기다리면 「생각하는 중…」이다', () => {
    expect(head([{ kind: 'tool', name: 'web_search', context: 'q', state: 'done' }])).toBe('생각하는 중…');
  });

  it('기다림 안내가 마지막이면 그 글을 보인다', () => {
    expect(head([{ kind: 'status', text: '⏳ waiting on qwen' }])).toBe('⏳ waiting on qwen');
  });
});

describe('Steps 머리줄 표시 점', () => {
  const dot = (live: boolean, items: Item[]) =>
    render(<Steps items={items} live={live} open={false} onToggle={() => {}} />).container.querySelector('summary [data-dot]') as HTMLElement;

  it('진행 중이면 두 점이 도는 궤도를 보인다', () => {
    const el = dot(true, [{ kind: 'status', text: '⏳ x' }]);
    expect(el.dataset.dot).toBe('run');
    expect(el.children).toHaveLength(2);
  });

  it('끝나면 멈춘 점 하나(성공 초록, 실패 빨강)다', () => {
    expect(dot(false, [{ kind: 'tool', name: 'a', state: 'done' }]).dataset.dot).toBe('ok');
    expect(dot(false, [{ kind: 'tool', name: 'a', state: 'failed' }]).dataset.dot).toBe('bad');
  });
});

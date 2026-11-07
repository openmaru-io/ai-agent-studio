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

  // 실패가 섞인 묶음은 빨강이 아니라 회색 점, 글만 「실패 포함」(스펙 2026-11-07-001 디자인 2D — 예전에는 빨강)
  it('끝나면 멈춘 점 하나(성공 초록, 실패 회색)다', () => {
    expect(dot(false, [{ kind: 'tool', name: 'a', state: 'done' }]).dataset.dot).toBe('ok');
    expect(dot(false, [{ kind: 'tool', name: 'a', state: 'failed' }]).dataset.dot).toBe('muted');
  });
});

describe('Steps 머리줄 라벨 우선순위(2026-11-07-001 디자인 1B)', () => {
  const done = (items: Item[]) => render(<Steps items={items} live={false} open onToggle={() => {}} />).container;

  it('안전장치 > 모델 설정 때문에 막힘 > 실패 포함', () => {
    const guard: Item = { kind: 'tool', name: 'terminal', state: 'failed', guard: 'rm' };
    const llm: Item = { kind: 'tool', name: 'text_to_speech', state: 'failed', llmBlocked: true };
    const bad: Item = { kind: 'tool', name: 'web', state: 'failed' };
    expect(done([guard, llm, bad]).querySelector('summary')?.textContent).toContain('안전장치가 막음');
    expect(done([llm, bad]).querySelector('summary')?.textContent).toContain('모델 설정 때문에 막힘');
    expect(done([bad]).querySelector('summary')?.textContent).toContain('실패 포함');
  });

  it('실패 이유는 줄 아래 회색 한 줄, 줄 끝 라벨은 「실패」', () => {
    const c = done([{ kind: 'tool', name: 'text_to_speech', state: 'failed', llmBlocked: true, failReason: 'HTTP 403' }]);
    expect(c.querySelector('[data-testid="fail-reason"]')?.textContent).toBe('HTTP 403');
    expect(c.querySelector('li')?.textContent).toContain('실패');
    expect(c.querySelector('summary [data-dot]')?.getAttribute('data-dot')).toBe('muted');
  });
});

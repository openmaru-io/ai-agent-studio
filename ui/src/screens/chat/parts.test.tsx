/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { act, render } from '@testing-library/react';
import { describe, expect, it, vi } from 'vitest';

import type { Item } from '@/lib/chat';

import { BusyHint, fmtToolMs, Steps, toolLabel } from './parts';

const head = (items: Item[]) =>
  render(<Steps items={items} live open={false} onToggle={() => {}} />).container.querySelector('summary')?.textContent;

describe('Steps 머리줄(진행 중)', () => {
  it('도는 도구는 이름과 맥락을 보인다', () => {
    const el = render(
      <Steps
        items={[{ kind: 'tool', name: 'web_search', context: 'q', state: 'running' }]}
        live
        open={false}
        onToggle={() => {}}
      />
    ).container;
    expect(el.querySelector('summary [data-running-tool] [data-tool-name]')?.textContent).toBe('web_search');
    expect(el.querySelector('summary [data-running-tool]')?.textContent).toContain('q');
    expect(el.querySelector('summary [data-tool-server]')).toBeNull();
  });

  // OMAI-1867: 「mcp__cogentai_database__diagnose_sql」 이 그대로 보였다
  it('MCP 도구는 접두사를 떼고 서버 이름을 카탈로그 표기로 따로 보인다', () => {
    const el = render(
      <Steps
        items={[{ kind: 'tool', name: 'mcp__cogentai_database__diagnose_sql', state: 'running' }]}
        live
        open={false}
        onToggle={() => {}}
      />
    ).container;
    expect(el.querySelector('summary [data-tool-name]')?.textContent).toBe('diagnose_sql');
    expect(el.querySelector('summary [data-tool-server]')?.textContent).toBe('cogentai-database');
    expect(el.querySelector('summary [title]')?.getAttribute('title')).toBe('mcp__cogentai_database__diagnose_sql');
  });

  it('도는 도구는 걸린 시간을 1초마다 늘려 보인다', () => {
    vi.useFakeTimers();
    try {
      const t0 = Date.now();
      const el = render(
        <Steps
          items={[{ kind: 'tool', name: 'web_search', state: 'running', t0 }]}
          live
          open={false}
          onToggle={() => {}}
        />
      ).container;
      expect(el.querySelector('[data-run-secs]')).toBeNull();
      act(() => vi.advanceTimersByTime(3000));
      expect(el.querySelector('[data-run-secs]')?.textContent).toBe('3초');
    } finally {
      vi.useRealTimers();
    }
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

describe('toolLabel', () => {
  it('MCP 도구 ID 를 도구와 서버로 나눈다', () => {
    expect(toolLabel('mcp__cogentai_database__diagnose_sql')).toEqual({
      tool: 'diagnose_sql',
      server: 'cogentai-database',
    });
    expect(toolLabel('mcp__chart__generate__bar')).toEqual({ tool: 'generate__bar', server: 'chart' });
  });
  it('MCP 가 아니면 그대로 둔다', () => {
    expect(toolLabel('web_search')).toEqual({ tool: 'web_search', server: '' });
    expect(toolLabel()).toEqual({ tool: '', server: '' });
  });
});

// OMAI-1868: 단계 목록의 도구 줄에 걸린 시간
describe('도구 줄의 걸린 시간', () => {
  it('1분 미만은 소수 한 자리 초, 1분부터는 분·초', () => {
    expect(fmtToolMs(3250)).toBe('3.3초');
    expect(fmtToolMs(65400)).toBe('1분 5초');
  });

  it('줄 오른쪽에 걸린 시간을 보이고, 가장 오래 걸린 줄만 강조한다', () => {
    const items: Item[] = [
      { kind: 'tool', name: 'tool_describe', state: 'done', ms: 800 },
      { kind: 'tool', name: 'tool_call', state: 'done', ms: 12400 },
      { kind: 'tool', name: 'tool_call', state: 'done' },
    ];
    const c = render(<Steps items={items} live={false} open onToggle={() => {}} />).container;
    const ms = [...c.querySelectorAll('[data-tool-ms]')];
    expect(ms.map((x) => x.textContent)).toEqual(['0.8초', '12.4초']);
    expect(ms[1].hasAttribute('data-slowest')).toBe(true);
    expect(ms[0].hasAttribute('data-slowest')).toBe(false);
  });

  it('시간을 잰 도구가 하나뿐이면 강조하지 않는다', () => {
    const c = render(<Steps items={[{ kind: 'tool', name: 'a', state: 'done', ms: 5000 }]} live={false} open onToggle={() => {}} />).container;
    expect(c.querySelector('[data-slowest]')).toBeNull();
  });
});

describe('BusyHint(입력 칸 아래 답하는 중)', () => {
  it('보낸 시각부터 1초마다 흐르는 시간을 보인다', () => {
    vi.useFakeTimers();
    try {
      const el = render(<BusyHint since={Date.now()} />).container;
      expect(el.textContent).toBe('답하는 중 · 0초 · /steer 방향 바꾸기 · /queue 다음 말 예약');
      act(() => vi.advanceTimersByTime(65_000));
      expect(el.querySelector('[data-busy-secs]')?.textContent).toBe('1분 5초');
    } finally {
      vi.useRealTimers();
    }
  });

  it('short(팝업)는 명령 안내 없이 「답하는 중 · N초」만', () => {
    const el = render(<BusyHint since={Date.now()} short />).container;
    expect(el.textContent).toBe('답하는 중 · 0초');
    expect(render(<BusyHint short />).container.textContent).toBe('답하는 중');
  });

  it('보낸 시각을 모르면(답하는 중에 다시 연 대화) 시간 없이 보인다', () => {
    const el = render(<BusyHint />).container;
    expect(el.textContent).toBe('답하는 중 · /steer 방향 바꾸기 · /queue 다음 말 예약');
  });
});

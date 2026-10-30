/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { fireEvent, render, screen } from '@testing-library/react';
import userEvent from '@testing-library/user-event';
import { useState } from 'react';
import { describe, expect, it, vi } from 'vitest';

import { FEdge, FNode, Graph } from '@/lib/flowLayout';

import { FlowCanvas } from './FlowCanvas';

const node = (id: string, kind: string, over: Partial<FNode> = {}): FNode => ({
  id,
  kind,
  label: id.split(':').pop() as string,
  sub: '',
  badges: [],
  depth: 0,
  meta: {},
  ...over,
});
const edge = (from: string, to: string, over: Partial<FEdge> = {}): FEdge => ({
  from,
  to,
  kind: 'calls',
  conf: 'doc',
  meta: {},
  evidence: [],
  ...over,
});

const GRAPH: Graph = {
  root: 'cron:ma/j1',
  nodes: [
    node('cron:ma/j1', 'cron', { label: 'nightly' }),
    node('skill:report', 'skill', { depth: 1, badges: ['등록됨'] }),
    node('script:run.py', 'script', { depth: 2 }),
    node('mcp:chart', 'mcp', { depth: 2 }),
    node('cred:KEY', 'cred', { depth: 3, status: 'bad' }),
  ],
  edges: [
    edge('cron:ma/j1', 'skill:report', { kind: 'runs' }),
    edge('skill:report', 'script:run.py'),
    edge('skill:report', 'mcp:chart', { conf: 'observed', meta: { observed: 3 } }),
    edge('mcp:chart', 'cred:KEY', { kind: 'uses', conf: 'code' }),
  ],
};

function Host(props: {
  hide?: Set<string>;
  query?: string;
  onSelect?: (n: FNode | null) => void;
  onEdge?: (e: FEdge) => void;
  initial?: string | null;
  graph?: Graph;
}) {
  const [sel, setSel] = useState<string | null>(props.initial ?? null);
  return (
    <FlowCanvas
      graph={props.graph ?? GRAPH}
      hide={props.hide ?? new Set()}
      query={props.query ?? ''}
      selected={sel}
      onSelect={(n) => {
        setSel(n ? n.id : null);
        props.onSelect?.(n);
      }}
      onEdge={props.onEdge ?? (() => undefined)}
    />
  );
}
const nodeBtn = (name: RegExp | string) => screen.getByRole('button', { name });

describe('FlowCanvas', () => {
  it('단 제목과 노드를 그린다. 노드의 이름에 종류·중심·배지가 들어간다', () => {
    render(<Host />);
    for (const t of ['중심', '1단계', '2단계', '3단계'])
      expect(screen.getByText(t)).toBeInTheDocument();
    expect(nodeBtn('예약 작업 nightly, 이 흐름의 중심')).toBeInTheDocument();
    expect(nodeBtn('스킬 report, 등록됨')).toBeInTheDocument();
    expect(nodeBtn('API 키·토큰 KEY')).toBeInTheDocument();
  });

  it('연결 선을 노드 수만큼 그리고 실행에서 확인된 횟수를 적는다', () => {
    const { container } = render(<Host />);
    expect(container.querySelectorAll('[data-edge]')).toHaveLength(4);
    expect(screen.getByText('✓ 3회')).toBeInTheDocument();
  });

  it('노드를 누르면 선택하고(aria-pressed), 이웃이 아닌 노드는 흐려진다', async () => {
    const user = userEvent.setup();
    const onSelect = vi.fn();
    render(<Host onSelect={onSelect} />);
    await user.click(nodeBtn(/^스킬 report/));
    expect(onSelect).toHaveBeenCalledWith(expect.objectContaining({ id: 'skill:report' }));
    expect(nodeBtn(/^스킬 report/)).toHaveAttribute('aria-pressed', 'true');
    expect(nodeBtn(/^예약 작업/)).toHaveAttribute('data-dim', 'false'); // 이웃
    expect(nodeBtn(/^API 키·토큰/)).toHaveAttribute('data-dim', 'true'); // 이웃이 아님
  });

  it('선택하지 않으면 아무것도 흐리지 않는다', () => {
    render(<Host />);
    for (const b of screen.getAllByRole('button', { name: /^(크론 작업|스킬|스크립트|MCP 서버|자격증명)/ }))
      expect(b).toHaveAttribute('data-dim', 'false');
  });

  it('찾기 글은 이름과 부제로 맞지 않는 노드를 흐리게 한다', () => {
    render(<Host query="chart" />);
    expect(nodeBtn(/^MCP 서버 chart/)).toHaveAttribute('data-dim', 'false');
    expect(nodeBtn(/^스킬 report/)).toHaveAttribute('data-dim', 'true');
  });

  it('둘째 줄은 종류 표시와 겹치는 말을 빼고 보이지만, 찾기는 서버 부제 전체로 맞춘다(디자인 D8)', () => {
    const graph: Graph = {
      root: 'skill:p5',
      nodes: [
        node('skill:p5', 'skill', { label: 'p5js', sub: 'main · 스킬' }),
        node('script:x', 'script', { label: 'export-frames.js', sub: 'JavaScript · 스킬 내부 스크립트', depth: 1 }),
        node('host:h', 'host', { label: 'cdn.jsdelivr.net', sub: '외부 호스트', depth: 1 }),
      ],
      edges: [edge('skill:p5', 'script:x'), edge('skill:p5', 'host:h')],
    };
    render(<Host graph={graph} query="내부 스크립트" />);
    expect(screen.getByText('JavaScript')).toBeInTheDocument();
    expect(screen.getByText('main')).toBeInTheDocument();
    expect(screen.queryByText('JavaScript · 스킬 내부 스크립트')).toBeNull();
    expect(screen.queryByText('외부 호스트')).toBeNull();
    expect(nodeBtn(/export-frames\.js/)).toHaveAttribute('data-dim', 'false');
    expect(nodeBtn(/cdn\.jsdelivr\.net/)).toHaveAttribute('data-dim', 'true');
  });

  it('숨긴 종류의 노드는 그리지 않고, 중심은 숨기지 않는다', () => {
    render(<Host hide={new Set(['mcp', 'cred', 'cron'])} />);
    expect(screen.queryByRole('button', { name: /^MCP 서버/ })).not.toBeInTheDocument();
    expect(screen.queryByRole('button', { name: /^API 키·토큰/ })).not.toBeInTheDocument();
    expect(nodeBtn(/^예약 작업/)).toBeInTheDocument();
  });

  it('방향키는 옆 단·같은 단의 가까운 노드로 포커스를 옮긴다', async () => {
    const user = userEvent.setup();
    render(<Host />);
    nodeBtn(/^스킬 report/).focus();
    await user.keyboard('{ArrowRight}');
    expect(document.activeElement?.getAttribute('data-id')).toMatch(/^(script|mcp):/);
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('data-id')).toBe('skill:report');
    await user.keyboard('{ArrowLeft}');
    expect(document.activeElement?.getAttribute('data-id')).toBe('cron:ma/j1');
  });

  it('선을 누르면 onEdge 를 부른다', () => {
    const onEdge = vi.fn();
    const { container } = render(<Host onEdge={onEdge} />);
    fireEvent.click(container.querySelector('[data-edge="skill:report>script:run.py"] .fc-hit') as Element);
    expect(onEdge).toHaveBeenCalledWith(expect.objectContaining({ from: 'skill:report', to: 'script:run.py' }));
  });

  it('확대·축소 단추는 배율을 바꾸고 0.3~1.6 으로 제한한다', async () => {
    const user = userEvent.setup();
    render(<Host />);
    const group = screen.getByRole('group', { name: '그림 보기 조절' });
    const label = () => group.querySelector('[aria-live]')?.textContent;
    expect(label()).toBe('80%'); // 읽기 좋게: jsdom 은 크기가 0 이라 0.8 로 시작
    await user.click(screen.getByRole('button', { name: '확대' }));
    expect(label()).toBe('96%');
    for (let i = 0; i < 10; i++) await user.click(screen.getByRole('button', { name: '확대' }));
    expect(label()).toBe('160%');
    for (let i = 0; i < 20; i++) await user.click(screen.getByRole('button', { name: '축소' }));
    expect(label()).toBe('30%');
    await user.click(screen.getByRole('button', { name: '읽기 좋게' }));
    expect(label()).toBe('80%');
  });

  it('그림이 칸보다 낮으면 세로 가운데에 둔다(가로처럼, 2026-10-17-023)', () => {
    const w = vi.spyOn(HTMLElement.prototype, 'clientWidth', 'get').mockReturnValue(2000);
    const h = vi.spyOn(HTMLElement.prototype, 'clientHeight', 'get').mockReturnValue(900);
    try {
      const { container } = render(<Host />);
      const stage = container.querySelector<HTMLElement>('[data-flow-stage]')!;
      const m = /translate\(([-\d.]+)px,\s*([-\d.]+)px\) scale\(([\d.]+)\)/.exec(stage.style.transform)!;
      const [tx, ty, scale] = [Number(m[1]), Number(m[2]), Number(m[3])];
      const [gw, gh] = [parseFloat(stage.style.width) * scale, parseFloat(stage.style.height) * scale];
      expect(gh).toBeLessThan(900);
      expect(ty).toBeCloseTo((900 - gh) / 2, 0); // 위·아래 여백이 같다
      expect(tx).toBeCloseTo((2000 - gw) / 2, 0); // 가로는 예전처럼 가운데
    } finally {
      w.mockRestore();
      h.mockRestore();
    }
  });

  it('빈 곳을 눌러(끌지 않고) 선택을 푼다', () => {
    const onSelect = vi.fn();
    const { container } = render(<Host initial="skill:report" onSelect={onSelect} />);
    const stage = container.querySelector('[data-testid="flow-stage"]') as HTMLElement;
    fireEvent.pointerDown(stage, { clientX: 10, clientY: 10, pointerId: 1 });
    fireEvent.pointerUp(stage, { clientX: 10, clientY: 10, pointerId: 1 });
    expect(onSelect).toHaveBeenCalledWith(null);
  });
});

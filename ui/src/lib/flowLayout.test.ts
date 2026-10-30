/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

import { describe, expect, it } from 'vitest';

import { COLS_H, FEdge, FNode, Graph, GX, layout, NODE_H, NODE_W, PAD } from './flowLayout';

const node = (id: string, kind: FNode['kind'], over: Partial<FNode> = {}): FNode => ({
  id,
  kind,
  label: id,
  sub: '',
  badges: [],
  depth: 0,
  meta: {},
  ...over,
});
const edge = (from: string, to: string, kind = 'calls'): FEdge => ({
  from,
  to,
  kind,
  conf: 'doc',
  meta: {},
  evidence: [],
});

const G = (): Graph => ({
  root: 'cron:ma/j1',
  nodes: [
    node('cron:ma/j1', 'cron'),
    node('skill:report', 'skill', { depth: 1 }),
    node('script:run.py', 'script', { depth: 2 }),
    node('mcp:chart', 'mcp', { depth: 2 }),
    node('cred:KEY', 'cred', { depth: 3 }),
    node('skill:other', 'skill', { depth: 2 }),
    node('lonely', 'lib', { depth: 3 }),
  ],
  edges: [
    edge('cron:ma/j1', 'skill:report', 'runs'),
    edge('skill:report', 'script:run.py'),
    edge('skill:report', 'mcp:chart'),
    edge('mcp:chart', 'cred:KEY', 'uses'),
    edge('skill:report', 'skill:other', 'refers'),
  ],
});

describe('layout', () => {
  it('중심에서 떨어진 거리로 단을 정한다: 중심 0, 1단계, 2단계, 3단계 (스펙 2026-10-28-013 D7)', () => {
    const L = layout(G());
    const col = (id: string) => L.cols[L.pos[id].c];
    expect(col('cron:ma/j1')).toBe('중심');
    expect(col('skill:report')).toBe('1단계');
    expect(col('skill:other')).toBe('2단계');
    expect(col('script:run.py')).toBe('2단계');
    expect(col('mcp:chart')).toBe('2단계');
    expect(col('cred:KEY')).toBe('3단계');
  });

  it('p5js 모양: 중심이 직접 부르는 스킬·스크립트·호스트는 한 단에 모여 단을 건너뛰는 선(지나가는 자리)이 없다', () => {
    const d1 = ['skill:a', 'skill:b', 'script:x1', 'script:x2', 'script:x3', 'script:x4', 'host:h1', 'host:h2', 'host:h3'];
    const d2 = ['host:h4', 'lib:l1', 'lib:l2', 'lib:l3'];
    const g: Graph = {
      root: 'skill:p5',
      nodes: [
        node('skill:p5', 'skill'),
        ...d1.map((id) => node(id, id.split(':')[0], { depth: 1 })),
        ...d2.map((id) => node(id, id.split(':')[0], { depth: 2 })),
      ],
      edges: [...d1.map((id) => edge('skill:p5', id)), ...d2.map((id) => edge('script:x1', id))],
    };
    const L = layout(g);
    expect(L.cols).toEqual(['중심', '1단계', '2단계']);
    expect(L.via.size === 0 || [...L.via.values()].every((v) => v.length === 0)).toBe(true);
    expect(Object.values(L.pos).filter((p) => p.n.lane)).toHaveLength(0);
  });

  it('중심과 스크립트가 같은 호스트를 부르면 호스트를 오른쪽 단으로 밀어 같은 단 안의 선이 없다(D6)', () => {
    const g: Graph = {
      root: 'skill:s',
      nodes: [node('skill:s', 'skill'), node('script:x', 'script', { depth: 1 }), node('host:h', 'host', { depth: 1 })],
      edges: [edge('skill:s', 'script:x'), edge('skill:s', 'host:h'), edge('script:x', 'host:h')],
    };
    const L = layout(g);
    expect(L.pos['host:h'].c).toBe(L.pos['script:x'].c + 1);
    for (const e of L.edges) expect(L.pos[e.to].c).toBeGreaterThan(L.pos[e.from].c);
    expect(L.via.get(L.edges.find((e) => e.from === 'skill:s' && e.to === 'host:h')!)).toHaveLength(1);
  });

  it('스크립트끼리 서로 import 하는 고리에서도 배치가 끝나고 노드가 겹치지 않는다', () => {
    const g: Graph = {
      root: 'skill:s',
      nodes: [node('skill:s', 'skill'), node('script:a', 'script', { depth: 1 }), node('script:b', 'script', { depth: 2 })],
      edges: [edge('skill:s', 'script:a'), edge('script:a', 'script:b', 'imports'), edge('script:b', 'script:a', 'imports')],
    };
    const L = layout(g);
    expect(L.nodes.map((n) => n.id).sort()).toEqual(['script:a', 'script:b', 'skill:s']);
    expect(L.pos['script:a'].x === L.pos['script:b'].x && L.pos['script:a'].y === L.pos['script:b'].y).toBe(false);
  });

  it('연결이 없는 노드는 그리지 않는다. 중심은 늘 그린다', () => {
    const L = layout(G());
    expect(L.nodes.map((n) => n.id)).not.toContain('lonely');
    expect(L.nodes.map((n) => n.id)).toContain('cron:ma/j1');
  });

  it('쓰지 않는 단은 건너뛰고 앞으로 당긴다', () => {
    const g: Graph = {
      root: 'skill:a',
      nodes: [node('skill:a', 'skill'), node('mcp:m', 'mcp', { depth: 1 })],
      edges: [edge('skill:a', 'mcp:m')],
    };
    const L = layout(g);
    expect(L.cols).toEqual(['중심', '1단계']);
    expect(L.pos['mcp:m'].c).toBe(1);
  });

  it('x 는 단 번호로, y 는 단 안의 줄로 정해지고 겹치지 않는다', () => {
    const L = layout(G());
    for (const n of L.nodes) expect(L.pos[n.id].x).toBe(PAD + L.pos[n.id].c * (NODE_W + GX));
    const byCol = new Map<number, { y: number; h: number }[]>();
    for (const n of L.nodes) {
      const p = L.pos[n.id];
      byCol.set(p.c, [...(byCol.get(p.c) ?? []), { y: p.y, h: p.h }]);
    }
    for (const list of byCol.values()) {
      list.sort((a, b) => a.y - b.y);
      for (let i = 1; i < list.length; i++) expect(list[i].y).toBeGreaterThanOrEqual(list[i - 1].y + list[i - 1].h);
    }
    expect(L.pos['cron:ma/j1'].y).toBeGreaterThanOrEqual(COLS_H);
  });

  it('단을 건너뛰는 선은 사이 단마다 지나가는 자리를 받는다', () => {
    const g: Graph = {
      root: 'cron:c',
      nodes: [
        node('cron:c', 'cron'),
        node('skill:s', 'skill', { depth: 1 }),
        node('script:x', 'script', { depth: 2 }),
        node('cred:k', 'cred', { depth: 3 }),
      ],
      edges: [
        edge('cron:c', 'skill:s'),
        edge('skill:s', 'script:x'),
        edge('script:x', 'cred:k'),
        edge('cron:c', 'cred:k', 'uses'),
      ],
    };
    const L = layout(g);
    const long = g.edges[3];
    const lanes = L.via.get(L.edges.find((e) => e.from === long.from && e.to === long.to)!)!;
    expect(lanes).toHaveLength(L.pos['cred:k'].c - L.pos['cron:c'].c - 1);
    for (const id of lanes) expect(L.pos[id].h).toBeLessThan(NODE_H);
  });

  it('숨긴 종류의 노드와 그 선을 뺀다. 중심은 숨기지 않는다', () => {
    const L = layout(G(), new Set(['mcp', 'cred', 'cron']));
    const ids = L.nodes.map((n) => n.id);
    expect(ids).not.toContain('mcp:chart');
    expect(ids).not.toContain('cred:KEY');
    expect(ids).toContain('cron:ma/j1');
    expect(L.edges.every((e) => ids.includes(e.from) && ids.includes(e.to))).toBe(true);
  });

  it('너비는 쓰는 단 수로, 높이는 가장 긴 단으로 정해진다', () => {
    const L = layout(G());
    expect(L.width).toBe(PAD * 2 + L.cols.length * NODE_W + (L.cols.length - 1) * GX);
    expect(L.height).toBeGreaterThan(COLS_H + PAD + NODE_H);
  });

  it('같은 입력은 같은 배치를 낸다', () => {
    const a = layout(G());
    const b = layout(G());
    expect(Object.fromEntries(a.nodes.map((n) => [n.id, [a.pos[n.id].x, a.pos[n.id].y]]))).toEqual(
      Object.fromEntries(b.nodes.map((n) => [n.id, [b.pos[n.id].x, b.pos[n.id].y]]))
    );
  });
});

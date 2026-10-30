/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 흐름 그림의 배치: 왼쪽에서 오른쪽으로 부르는 곳 → 중심 → 1단계 → 2단계 …
// 단(column)은 중심에서 떨어진 거리로 정한다(스펙 2026-10-28-013 §3-3-1). 종류로 나누면 중심이 직접 부르는 스크립트·호스트로 가는
// 선이 단을 건너뛰며 엇갈렸다. 같은 단이나 왼쪽 단에서 들어오는 연결이 있으면 받는 노드를 오른쪽으로 밀어 선이 왼쪽→오른쪽으로만 간다(D6).
// 단 안에서는 종류 순서로 묶고, 앞 단 이웃의 평균 높이 순으로 줄을 세워 선이 덜 엇갈리게 한다.
// 단을 건너뛰는 선은 사이 단마다 좁은 「지나가는 자리」를 하나씩 받아 남의 노드 뒤로 지나가지 않는다.

import { t } from '@/i18n';

export type FKind = 'cron' | 'skill' | 'script' | 'mcp' | 'host' | 'cred' | 'lib' | 'lane';

export interface FNode {
  id: string;
  kind: Exclude<FKind, 'lane'> | string;
  label: string;
  sub: string;
  badges: string[];
  depth: number;
  status?: string;
  more?: number;
  meta: Record<string, string>;
  path?: string;
  profile?: string;
  link?: { view: string; params?: Record<string, string> };
  lane?: boolean;
  /** 스킬 노드: 스킬 목록·서랍과 같은 규칙으로 센 외부 호스트 수(스펙 2026-10-28-013 D5) */
  n_hosts?: number;
}
export interface FEdge {
  from: string;
  to: string;
  kind: string;
  conf: string;
  meta: { observed?: number; tools?: string[]; urls?: string[]; bundled?: boolean };
  evidence: { file: string; line?: number; text?: string }[];
}
export interface Graph {
  root: string;
  nodes: FNode[];
  edges: FEdge[];
  truncated?: boolean;
  hidden_mentions?: number;
  /** 중심 스킬의 외부 호스트 수. 그림이 잘려도 서랍과 같은 수(재검토 D3) */
  root_hosts?: number | null;
  observed?: { error?: string; hint?: string; days?: number; scope?: string; runs: number; matched: number };
}

export const NODE_W = 216;
export const NODE_H = 56;
export const GX = 72;
export const GY = 12;
export const PAD = 28;
export const COLS_H = 30;
const LANE = 14;
// 단 제목은 순서만 말한다(D7) — 무엇인지는 노드의 종류 표시(KindMark)가 알린다
const columnLabel = (layer: number) =>
  layer < 0 ? t('flows.col.caller') : layer === 0 ? t('flows.col.center') : t('flows.col.step', { n: layer });

export interface Pos {
  c: number;
  n: FNode;
  h: number;
  x: number;
  y: number;
  i: number;
  ends?: string[];
}
export interface Layout {
  nodes: FNode[];
  edges: FEdge[];
  pos: Record<string, Pos>;
  via: Map<FEdge, string[]>;
  cols: string[];
  width: number;
  height: number;
}

/** 노드 → 단 번호(-1 부르는 곳, 0 중심, 1… 단계). 서버 depth(가장 짧은 거리)에서 시작해 같은 단·왼쪽 단에서
 *  들어오는 연결이 있으면 받는 쪽을 보내는 쪽 + 1 로 민다. 고리가 있어도 끝나도록 단 수만큼만 되풀이한다. */
function layersOf(nodes: FNode[], edges: FEdge[], root: string): Map<string, number> {
  const layer = new Map(nodes.map((n) => [n.id, n.id === root ? 0 : n.depth < 0 ? -1 : Math.max(1, n.depth)]));
  const rounds = new Set(layer.values()).size + 1;
  for (let k = 0; k < rounds; k++) {
    let moved = false;
    for (const e of edges) {
      const a = layer.get(e.from);
      const b = layer.get(e.to);
      if (a == null || b == null || a < 0 || b < 0 || e.to === root) continue;
      if (b <= a) {
        layer.set(e.to, a + 1);
        moved = true;
      }
    }
    if (!moved) break;
  }
  return layer;
}

const ORDER: Record<string, number> = { cron: 0, skill: 1, script: 2, mcp: 3, host: 4, cred: 5, lib: 6, lane: 7 };

export function layout(graph: Graph, hide: Set<string> = new Set()): Layout {
  const root = graph.nodes.find((n) => n.id === graph.root) as FNode;
  const nodes = graph.nodes.filter((n) => n.id === graph.root || !hide.has(n.kind));
  const ids = new Set(nodes.map((n) => n.id));
  const edges = graph.edges.filter((e) => ids.has(e.from) && ids.has(e.to));
  const linked = new Set([graph.root]);
  edges.forEach((e) => {
    linked.add(e.from);
    linked.add(e.to);
  });
  const shown = nodes.filter((n) => linked.has(n.id));
  const layer = layersOf(shown, edges, root.id);
  const used = [...new Set(shown.map((n) => layer.get(n.id) as number))].sort((a, b) => a - b);
  const cols: FNode[][] = used.map(() => []);
  const pos: Record<string, Pos> = {};
  shown.forEach((n) => {
    const c = used.indexOf(layer.get(n.id) as number);
    cols[c].push(n);
    pos[n.id] = { c, n, h: NODE_H, x: 0, y: 0, i: 0 };
  });

  const long = edges.filter((e) => Math.abs(pos[e.to].c - pos[e.from].c) > 1);
  const via = new Map<FEdge, string[]>(); // 선 → 지나가는 자리들(왼쪽 단부터)
  if (long.length <= 40)
    long.forEach((e, k) => {
      const a = Math.min(pos[e.from].c, pos[e.to].c);
      const b = Math.max(pos[e.from].c, pos[e.to].c);
      const list: string[] = [];
      for (let c = a + 1; c < b; c++) {
        const v: FNode = {
          id: `lane:${k}:${c}`,
          kind: 'lane',
          label: '',
          sub: '',
          badges: [],
          depth: 0,
          meta: {},
          lane: true,
        };
        cols[c].push(v);
        pos[v.id] = { c, n: v, h: LANE, x: 0, y: 0, i: 0, ends: [e.from, e.to] };
        list.push(v.id);
      }
      via.set(e, list);
    });
  cols.forEach((col) => col.sort((a, b) => ORDER[a.kind] - ORDER[b.kind] || a.label.localeCompare(b.label)));

  const place = () =>
    cols.forEach((col, c) => {
      let y = COLS_H + PAD;
      col.forEach((n, i) => {
        const p = pos[n.id];
        p.x = PAD + c * (NODE_W + GX);
        p.y = y;
        p.i = i;
        y += p.h + (n.lane ? 6 : GY);
      });
    });
  place();

  const mid = (id: string) => pos[id].y + pos[id].h / 2;
  const neighbours = (n: FNode): string[] =>
    n.lane
      ? (pos[n.id].ends as string[])
      : edges.filter((e) => e.to === n.id || e.from === n.id).map((e) => (e.to === n.id ? e.from : e.to));
  for (let pass = 0; pass < 4; pass++) {
    const sweep = pass % 2 === 0 ? cols.map((_, c) => c) : cols.map((_, c) => cols.length - 1 - c);
    sweep.forEach((c) => {
      const side = pass % 2 === 0 ? (o: string) => pos[o].c < c : (o: string) => pos[o].c > c;
      const key = (n: FNode) => {
        const ys = neighbours(n).filter(side).map(mid);
        return ys.length ? ys.reduce((x, y) => x + y, 0) / ys.length : null;
      };
      const keyed = cols[c].map((n, i): [number, number, FNode] => {
        const k = key(n);
        return [k == null ? mid(n.id) : k, i, n];
      });
      keyed.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
      cols[c] = keyed.map((k) => k[2]);
    });
    place();
  }

  const height =
    Math.max(
      ...cols.map((col) => (col.length ? pos[col[col.length - 1].id].y + pos[col[col.length - 1].id].h : 0)),
      COLS_H + PAD + NODE_H
    ) + PAD;
  return {
    nodes: shown,
    edges,
    pos,
    via,
    cols: used.map(columnLabel),
    width: PAD * 2 + used.length * NODE_W + (used.length - 1) * GX,
    height,
  };
}

/** 중심 패널 「외부 호스트 N」의 대상: 중심에서 스크립트만 거쳐 닿는 호스트와 그 연결(스펙 2026-10-28-013 디자인 D5).
 *  다른 스킬·MCP 서버를 거치지 않고, 「이름만 언급」 연결은 빼고, 스크립트는 깊이 3 까지(서버 script_refs 와 같은 규칙). */
export const MAX_SCRIPT_DEPTH = 3;
export function hostsFromRoot(graph: Graph): { host: string; edge: FEdge }[] {
  const out = new Map<string, FEdge[]>();
  graph.edges.forEach((e) => {
    if (e.conf !== 'mention') out.set(e.from, [...(out.get(e.from) ?? []), e]);
  });
  const found = new Map<string, FEdge>();
  const best = new Map<string, number>();
  const queue: [string, number][] = [[graph.root, -1]];
  while (queue.length) {
    const [cur, depth] = queue.shift() as [string, number];
    for (const e of out.get(cur) ?? []) {
      if (e.to.startsWith('host:')) {
        if (!found.has(e.to)) found.set(e.to, e);
      } else if (e.to.startsWith('script:') && depth + 1 <= MAX_SCRIPT_DEPTH && (best.get(e.to) ?? 99) > depth + 1) {
        best.set(e.to, depth + 1);
        queue.push([e.to, depth + 1]);
      }
    }
  }
  return [...found].map(([host, edge]) => ({ host, edge }));
}

/*
 * Copyright 2026 OPENMARU, Inc.
 * SPDX-License-Identifier: Apache-2.0
 */

// 「파일」 서랍 폴더 트리(스펙 2026-10-27-012 §5-2): 파일 줄에서 폴더를 만들고, 한 갈래 폴더를 합치고, 폴더 먼저·최근 순으로 놓는다.
import { describe, expect, it } from 'vitest';

import type { ListingEntry } from './chatFiles';
import { buildTree, collapse, findFolder, TreeFolder, TreeNode, visibleAncestor, visibleRows, withAncestors } from './fileTree';

const file = (path: string, mtime = 1, size = 10): ListingEntry => ({
  path,
  name: path.split('/').pop() || path,
  size,
  mtime,
  kind: 'file',
  downloadable: true,
  reason: '',
});
const dir = (path: string): ListingEntry => ({ path, name: path.split('/').pop() || path, size: 0, mtime: 1, kind: 'dir', downloadable: false, reason: 'dir' });
const labels = (nodes: TreeNode[]) => nodes.map((n) => (n.kind === 'dir' ? `${n.label}/` : n.entry.name));
const folder = (nodes: TreeNode[], label: string) => nodes.find((n): n is TreeFolder => n.kind === 'dir' && n.label === label)!;

describe('buildTree', () => {
  it('폴더 줄(kind dir)은 쓰지 않는다 — 아래 파일이 없는 폴더는 생기지 않는다', () => {
    expect(buildTree([dir('workspace/empty'), dir('workspace/empty/deeper')])).toEqual([]);
    expect(labels(buildTree([dir('workspace/empty'), file('workspace/a.md')]))).toEqual(['a.md']);
  });

  it('한 갈래 폴더를 합친다. 갈래가 둘이거나 폴더 안에 파일이 있으면 합치지 않는다', () => {
    const one = buildTree([file('workspace/.hermes/plans/p.md')]);
    expect(labels(one)).toEqual(['.hermes/plans/']);
    const plans = one[0] as TreeFolder;
    expect(plans.path).toBe('workspace/.hermes/plans');
    expect(plans.chain).toEqual(['workspace/.hermes', 'workspace/.hermes/plans']);
    expect(plans.depth).toBe(0);
    expect((plans.children[0] as { depth: number }).depth).toBe(1);

    expect(labels(buildTree([file('workspace/rooms/13/a.md'), file('workspace/rooms/14/b.md')]))).toEqual(['rooms/']);
    const withFile = buildTree([file('workspace/rooms/13/a.md'), file('workspace/rooms/x.md')]);
    expect(labels(withFile)).toEqual(['rooms/']);
    expect(labels(folder(withFile, 'rooms').children)).toEqual(['13/', 'x.md']);
  });

  it('같은 깊이에서 폴더가 먼저, 폴더는 아래 최근 시각 순, 파일은 시각 순(D1)', () => {
    const t = buildTree([file('workspace/old.md', 5), file('workspace/a/x.md', 1), file('workspace/b/y.md', 9), file('workspace/new.md', 7)]);
    expect(labels(t)).toEqual(['b/', 'a/', 'new.md', 'old.md']);
  });

  it('폴더의 파일 수·크기 합·최근 시각은 아래 모든 깊이를 더한 값이다', () => {
    const t = buildTree([file('workspace/r/a.md', 3, 100), file('workspace/r/s/b.md', 8, 20), file('workspace/r/s/c.md', 2, 5)]);
    const r = folder(t, 'r');
    expect([r.files, r.size, r.mtime]).toEqual([3, 125, 8]);
    expect([folder(r.children, 's').files, folder(r.children, 's').size]).toEqual([2, 25]);
  });
});

describe('펼침 계산', () => {
  const t = buildTree([file('workspace/r/s/b.md'), file('workspace/r/a.md'), file('workspace/top.md')]);

  it('visibleRows 는 접힌 폴더의 자식을 건너뛴다', () => {
    expect(labels(visibleRows(t, new Set()))).toEqual(['r/', 'top.md']);
    expect(labels(visibleRows(t, new Set(['workspace/r'])))).toEqual(['r/', 's/', 'a.md', 'top.md']);
    expect(labels(visibleRows(t, new Set(['workspace/r', 'workspace/r/s'])))).toEqual(['r/', 's/', 'b.md', 'a.md', 'top.md']);
  });

  it('withAncestors 는 기억한 경로의 위 폴더를 더한다(R2·R6) — 합치기가 풀려도 펼쳐 둔 폴더가 보인다', () => {
    expect([...withAncestors(new Set(['workspace/r/s']))].sort()).toEqual(['workspace/r', 'workspace/r/s']);
    expect(labels(visibleRows(t, withAncestors(new Set(['workspace/r/s']))))).toContain('b.md');
  });

  it('collapse 는 접은 폴더(합친 사슬 포함)와 그 아래 기억을 지운다(R3)', () => {
    const plans = buildTree([file('workspace/.hermes/plans/x/p.md')])[0] as TreeFolder;
    const left = collapse(new Set(['workspace/.hermes', 'workspace/.hermes/plans/x', 'workspace/other']), plans);
    expect([...left]).toEqual(['workspace/other']);
  });

  it('visibleAncestor 는 접힌 폴더 안 파일의 보이는 가장 가까운 위 폴더를 준다(5A)', () => {
    expect(visibleAncestor('workspace/r/s/b.md', t, new Set())).toBe('workspace/r');
    expect(visibleAncestor('workspace/r/s/b.md', t, new Set(['workspace/r']))).toBe('workspace/r/s');
    expect(visibleAncestor('workspace/r/s/b.md', t, new Set(['workspace/r', 'workspace/r/s']))).toBeUndefined();
    expect(visibleAncestor('workspace/top.md', t, new Set())).toBeUndefined();
    expect(visibleAncestor('workspace/uploads/x.png', t, new Set())).toBeUndefined();
  });

  it('findFolder 는 합친 줄이어도 사슬 안 경로로 폴더를 찾는다(reveal)', () => {
    const nested = buildTree([file('workspace/.hermes/plans/x/p.md'), file('workspace/top.md')]);
    expect(findFolder(nested, 'workspace/.hermes/plans')?.label).toBe('.hermes/plans/x');
    expect(findFolder(nested, 'workspace/nope')).toBeUndefined();
  });
});
